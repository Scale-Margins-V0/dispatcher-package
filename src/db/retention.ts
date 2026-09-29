/**
 * Hourly retention sweep over the state DB so an always-on dispatcher can't
 * grow its tables unbounded. Windows are deliberately generous; tune via env.
 *
 * One window is NOT generous and NOT optional: provider_message_ids is pruned
 * on `DISPATCHER_MESSAGE_ID_TTL`, which has no default. See config/message-id-ttl.ts.
 *
 * The sweep runs hourly, so a row survives at most one tick past its window —
 * a 2h setting deletes rows between 2h and 3h old, never younger than 2h.
 */

import { and, desc, eq, lt, lte, or } from "drizzle-orm";
import { getDb, isDbInitialized } from "./client.js";
import { queryDb, tableFor } from "./dialect-helpers.js";
import { MESSAGE_ID_TTL_SETTING, messageIdTtlMs } from "../config/message-id-ttl.js";
import { componentLogger } from "../logging/logger.js";

const log = componentLogger("db.retention");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function intEnv(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** dispatcher.retention.metrics_days — 7 by default, never more than 30. */
export function metricsRetentionDays(): number {
  return Math.min(intEnv("DISPATCHER_METRICS_RETENTION_DAYS", 7), 30);
}

export async function runRetentionSweep(now: Date = new Date()): Promise<void> {
  if (!isDbInitialized()) return;
  const dbx = getDb();
  const q = queryDb(dbx);
  const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);

  const logs = tableFor(dbx, "appLogs");
  await q
    .delete(logs)
    .where(lt(logs.ts, daysAgo(intEnv("DISPATCHER_LOG_RETENTION_DAYS", 14))));

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

  // Highest-volume table in the state DB — one row per recipient per send, so a
  // 50,000-recipient campaign writes 50,000 rows. Shorter window and its own cap.
  // campaign_summary keeps the totals after these rows are gone.
  const sendLogs = tableFor(dbx, "dispatchSendLogs");
  await q
    .delete(sendLogs)
    .where(lt(sendLogs.occurred_at, daysAgo(intEnv("DISPATCHER_SEND_LOG_RETENTION_DAYS", 30))));
  const maxSendLogRows = intEnv("DISPATCHER_SEND_LOG_MAX_ROWS", 1_000_000);
  const sendLogBoundary: Array<{ ts: Date; id: string }> = await q
    .select({ ts: sendLogs.occurred_at, id: sendLogs.id })
    .from(sendLogs)
    .orderBy(desc(sendLogs.occurred_at), desc(sendLogs.id))
    .offset(maxSendLogRows)
    .limit(1);
  if (sendLogBoundary[0]) {
    await q
      .delete(sendLogs)
      .where(
        or(
          lt(sendLogs.occurred_at, sendLogBoundary[0].ts),
          and(eq(sendLogs.occurred_at, sendLogBoundary[0].ts), lte(sendLogs.id, sendLogBoundary[0].id))
        )
      );
  }

  // Provider message ids. The window is mandatory and validated at boot, so a
  // bad value here means someone changed the environment under a running
  // process. Isolated deliberately: an unparseable TTL must not abort the rest
  // of this function, or one missing setting would quietly stop app_logs,
  // campaign_events and dispatch_send_logs from being pruned as well — far
  // worse than the unbounded table it was meant to prevent.
  //
  // No row cap either: the operator chose a duration, and deleting inside their
  // window because some count was reached would make the setting a lie.
  try {
    const cutoff = new Date(now.getTime() - messageIdTtlMs());
    const messageIds = tableFor(dbx, "providerMessageIds");
    await q.delete(messageIds).where(lt(messageIds.sent_at, cutoff));
    // Saved API response values live exactly as long as the message ids they key on.
    const responseRefs = tableFor(dbx, "apiResponseRefs");
    await q.delete(responseRefs).where(lt(responseRefs.sent_at, cutoff));
  } catch (error) {
    log.warn(
      { err: error instanceof Error ? error : new Error(String(error)) },
      `Skipped pruning provider_message_ids and api_response_refs — ${MESSAGE_ID_TTL_SETTING} is unusable. ` +
        "The table will grow until this is fixed; every other table was still swept."
    );
  }

  // campaign_summary is deliberately absent from this sweep. Outliving the rows
  // it was computed from is the entire reason it exists.

  const runs = tableFor(dbx, "dispatchRuns");
  await q.delete(runs).where(lt(runs.occurred_at, daysAgo(90)));
  const failures = tableFor(dbx, "dispatchRecipientFailures");
  await q.delete(failures).where(lt(failures.occurred_at, daysAgo(90)));
  const webhooks = tableFor(dbx, "webhookActivity");
  await q.delete(webhooks).where(lt(webhooks.occurred_at, daysAgo(90)));

  const outbox = tableFor(dbx, "eventOutbox");
  await q
    .delete(outbox)
    .where(
      and(eq(outbox.status, "delivered"), lt(outbox.created_at, daysAgo(7)))
    );
  await q
    .delete(outbox)
    .where(
      and(eq(outbox.status, "failed"), lt(outbox.created_at, daysAgo(30)))
    );

  const callbacks = tableFor(dbx, "campaignCallbacks");
  await q.delete(callbacks).where(lt(callbacks.last_used_at, daysAgo(30)));

  // Per-minute metrics: small (rollups, not raw events) but only useful recent.
  const metrics = tableFor(dbx, "dispatchMetrics");
  await q
    .delete(metrics)
    .where(lt(metrics.minute, Math.floor(daysAgo(metricsRetentionDays()).getTime() / 60_000)));

  const devSent = tableFor(dbx, "devSentCampaigns");
  await q.delete(devSent).where(lt(devSent.sent_at, daysAgo(7)));

  // Onsite: drop activations and sessions well past expiry, and age out
  // receipts. Decisions are frozen snapshots reused across channels, so keep
  // them the longest.
  const onsiteRetentionDays = intEnv("DISPATCHER_ONSITE_RETENTION_DAYS", 30);
  const onsiteActivations = tableFor(dbx, "onsiteActivations");
  await q
    .delete(onsiteActivations)
    .where(lt(onsiteActivations.expires_at, daysAgo(onsiteRetentionDays)));
  const onsiteSessions = tableFor(dbx, "onsiteSessions");
  await q
    .delete(onsiteSessions)
    .where(
      lt(onsiteSessions.absolute_expires_at, daysAgo(onsiteRetentionDays))
    );
  const onsiteReceipts = tableFor(dbx, "onsiteReceipts");
  await q
    .delete(onsiteReceipts)
    .where(lt(onsiteReceipts.received_at, daysAgo(90)));
  const onsiteDecisions = tableFor(dbx, "onsiteDecisions");
  await q
    .delete(onsiteDecisions)
    .where(lt(onsiteDecisions.updated_at, daysAgo(90)));
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
