/**
 * Hourly retention sweep over the state DB so an always-on dispatcher can't
 * grow its tables unbounded. Windows are deliberately generous; tune via env.
 */

import { and, desc, eq, lt, lte, or } from "drizzle-orm";
import { getDb, isDbInitialized } from "./client.js";
import { queryDb, tableFor } from "./dialect-helpers.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function intEnv(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function runRetentionSweep(now: Date = new Date()): Promise<void> {
  if (!isDbInitialized()) return;
  const dbx = getDb();
  const q = queryDb(dbx);
  const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);

  const logs = tableFor(dbx, "appLogs");
  await q.delete(logs).where(lt(logs.ts, daysAgo(intEnv("DISPATCHER_LOG_RETENTION_DAYS", 14))));

  // Row cap: find the ts/id at the cap boundary and delete everything older.
  const maxRows = intEnv("DISPATCHER_LOG_MAX_ROWS", 200_000);
  const boundary: Array<{ ts: Date; id: string }> = await q
    .select({ ts: logs.ts, id: logs.id })
    .from(logs)
    .orderBy(desc(logs.ts), desc(logs.id))
    .offset(maxRows)
    .limit(1);
  if (boundary[0]) {
    await q
      .delete(logs)
      .where(
        or(
          lt(logs.ts, boundary[0].ts),
          and(eq(logs.ts, boundary[0].ts), lte(logs.id, boundary[0].id))
        )
      );
  }

  const events = tableFor(dbx, "campaignEvents");
  await q
    .delete(events)
    .where(
      lt(events.occurred_at, daysAgo(intEnv("DISPATCHER_CAMPAIGN_EVENTS_RETENTION_DAYS", 90)))
    );
  // Row cap mirrors the app_logs boundary pattern.
  const maxEventRows = intEnv("DISPATCHER_CAMPAIGN_EVENTS_MAX_ROWS", 500_000);
  const eventBoundary: Array<{ ts: Date; id: string }> = await q
    .select({ ts: events.occurred_at, id: events.id })
    .from(events)
    .orderBy(desc(events.occurred_at), desc(events.id))
    .offset(maxEventRows)
    .limit(1);
  if (eventBoundary[0]) {
    await q
      .delete(events)
      .where(
        or(
          lt(events.occurred_at, eventBoundary[0].ts),
          and(eq(events.occurred_at, eventBoundary[0].ts), lte(events.id, eventBoundary[0].id))
        )
      );
  }

  const runs = tableFor(dbx, "dispatchRuns");
  await q.delete(runs).where(lt(runs.occurred_at, daysAgo(90)));
  const failures = tableFor(dbx, "dispatchRecipientFailures");
  await q.delete(failures).where(lt(failures.occurred_at, daysAgo(90)));
  const webhooks = tableFor(dbx, "webhookActivity");
  await q.delete(webhooks).where(lt(webhooks.occurred_at, daysAgo(90)));

  const outbox = tableFor(dbx, "eventOutbox");
  await q
    .delete(outbox)
    .where(and(eq(outbox.status, "delivered"), lt(outbox.created_at, daysAgo(7))));
  await q
    .delete(outbox)
    .where(and(eq(outbox.status, "failed"), lt(outbox.created_at, daysAgo(30))));

  const callbacks = tableFor(dbx, "campaignCallbacks");
  await q.delete(callbacks).where(lt(callbacks.last_used_at, daysAgo(30)));

  const devSent = tableFor(dbx, "devSentCampaigns");
  await q.delete(devSent).where(lt(devSent.sent_at, daysAgo(7)));
}

let retentionTimer: NodeJS.Timeout | null = null;

export function startRetentionJob(): void {
  if (process.env.VITEST === "true" || retentionTimer) return;
  const run = () => {
    void runRetentionSweep().catch(() => {
      // Sweeps are best-effort; the next hourly tick retries.
    });
  };
  run();
  retentionTimer = setInterval(run, HOUR_MS);
  retentionTimer.unref();
}

export function stopRetentionJobForTests(): void {
  if (retentionTimer) clearInterval(retentionTimer);
  retentionTimer = null;
}
