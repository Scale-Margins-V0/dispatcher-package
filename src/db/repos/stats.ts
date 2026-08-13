/**
 * Bounded aggregates for the data-plane status API. Every function here is a
 * single grouped query over an indexed column — no per-recipient work, no
 * unbounded scans. Each returns null rather than throwing so the status
 * endpoint can report "database unreachable" instead of failing the request.
 */

import { and, count, eq, gte, sql } from "drizzle-orm";
import { getDb, isDbInitialized } from "../client.js";
import { queryDb, tableFor } from "../dialect-helpers.js";
import { componentLogger } from "../../logging/logger.js";

const log = componentLogger("api.stats");

export type DispatchWindowStats = {
  dispatched: number;
  failed: number;
  runs: number;
  by_channel: Record<string, number>;
};

export function windowStart(days: number, now = new Date()): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** Swallow-and-log: a status endpoint must degrade, never 500. */
async function safe<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  if (!isDbInitialized()) return null;
  try {
    return await fn();
  } catch (error) {
    log.warn(
      `[stats] ${label} failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Dispatch outcomes in the window, from the events the send path emits.
 * `dispatched` counts messages a provider accepted; `failed` counts rejections
 * and recipients that could not be resolved to an address.
 */
export async function dispatchWindowStats(
  days: number
): Promise<DispatchWindowStats | null> {
  return safe("dispatchWindowStats", async () => {
    const dbx = getDb();
    const events = tableFor(dbx, "campaignEvents");
    const since = windowStart(days);

    const rows: Array<{ event: string; channel: string; total: number }> =
      await queryDb(dbx)
        .select({
          event: events.event,
          channel: events.channel,
          total: count().as("total"),
        })
        .from(events)
        .where(gte(events.occurred_at, since))
        .groupBy(events.event, events.channel);

    const stats: DispatchWindowStats = {
      dispatched: 0,
      failed: 0,
      runs: 0,
      by_channel: {},
    };
    for (const row of rows) {
      const total = Number(row.total) || 0;
      if (row.event === "dispatched") {
        stats.dispatched += total;
        stats.by_channel[row.channel] = (stats.by_channel[row.channel] ?? 0) + total;
      } else if (row.event === "failed") {
        stats.failed += total;
      }
    }

    const runs = tableFor(dbx, "dispatchRuns");
    const runRows: Array<{ total: number }> = await queryDb(dbx)
      .select({ total: count().as("total") })
      .from(runs)
      .where(and(gte(runs.occurred_at, since), eq(runs.status, "completed")));
    stats.runs = Number(runRows[0]?.total) || 0;

    return stats;
  });
}

/** Most recent dispatch of any status, as an ISO string. */
export async function lastDispatchAt(): Promise<string | null> {
  return safe("lastDispatchAt", async () => {
    const dbx = getDb();
    const runs = tableFor(dbx, "dispatchRuns");
    const rows: Array<{ latest: unknown }> = await queryDb(dbx)
      .select({ latest: sql`max(${runs.occurred_at})`.as("latest") })
      .from(runs);
    const latest = rows[0]?.latest;
    if (latest === null || latest === undefined) return null;
    const date = latest instanceof Date ? latest : new Date(Number(latest) || String(latest));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  });
}

/**
 * Variable-resolution warnings in the window.
 *
 * NOT a fallback rate. The resolver logs only *thrown* failures, deduplicated
 * by effective inputs — one broken query serving 50,000 recipients logs once,
 * and a source that returns empty falls back with no log at all. Report this as
 * a warning count and leave `fallback_rate` null until per-recipient
 * instrumentation exists. See docs/atlas-api-plan.md §8.
 */
export async function resolutionWarningCount(days: number): Promise<number | null> {
  return safe("resolutionWarningCount", async () => {
    const dbx = getDb();
    const logs = tableFor(dbx, "appLogs");
    const rows: Array<{ total: number }> = await queryDb(dbx)
      .select({ total: count().as("total") })
      .from(logs)
      .where(
        and(
          gte(logs.ts, windowStart(days)),
          eq(logs.component, "variables.resolver"),
          eq(logs.level, "warn")
        )
      );
    return Number(rows[0]?.total) || 0;
  });
}

export async function countVariables(): Promise<{ total: number; enabled: number } | null> {
  return safe("countVariables", async () => {
    const dbx = getDb();
    const variables = tableFor(dbx, "variables");
    const rows: Array<{ enabled: unknown; total: number }> = await queryDb(dbx)
      .select({ enabled: variables.enabled, total: count().as("total") })
      .from(variables)
      .groupBy(variables.enabled);
    let total = 0;
    let enabled = 0;
    for (const row of rows) {
      const n = Number(row.total) || 0;
      total += n;
      // SQLite stores booleans as 0/1; MySQL/PG hand back real booleans.
      if (row.enabled === true || row.enabled === 1) enabled += n;
    }
    return { total, enabled };
  });
}

/** Cheap liveness probe for the state database. */
export async function stateDatabaseReachable(): Promise<boolean> {
  const result = await safe("stateDatabaseReachable", async () => {
    const dbx = getDb();
    await queryDb(dbx).select({ ok: sql`1`.as("ok") }).from(tableFor(dbx, "dispatcherMeta")).limit(1);
    return true;
  });
  return result === true;
}
