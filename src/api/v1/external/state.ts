/**
 * GET /api/v1/data-plane/state — everything on the Atlas dashboard, in one call.
 *
 * Two rules this endpoint lives by:
 *
 * 1. **Placeholders are null, never zero.** `fallback_rate: 0` reads as
 *    "perfect"; null reads as "not measured". Atlas renders null as a dash.
 * 2. **Never 500 for an expected condition.** If the state database is
 *    unreachable the counters come back null and the status says so — a
 *    dashboard reporting "up, but its database is unreachable" is far more
 *    useful than a failed request.
 */

import type { Request, Response } from "express";
import { countOutboxByStatus } from "../../../db/repos/outbox.js";
import {
  countVariables,
  dispatchWindowStats,
  lastDispatchAt,
  resolutionWarningCount,
  stateDatabaseReachable,
} from "../../../db/repos/stats.js";
import { getRuntimeStatus } from "../../../ops/diagnostics.js";
import { STATUS_WINDOW_DAYS } from "../version.js";

export async function stateHandler(_req: Request, res: Response): Promise<void> {
  const days = STATUS_WINDOW_DAYS;

  const [runtime, dbReachable, dispatch, variables, warnings, lastDispatch] =
    await Promise.all([
      Promise.resolve(getRuntimeStatus()),
      stateDatabaseReachable(),
      dispatchWindowStats(days),
      countVariables(),
      resolutionWarningCount(days),
      lastDispatchAt(),
    ]);

  const outbox = await countOutboxByStatus().catch(() => null);

  const checks = {
    ...runtime.checks,
    state_database: dbReachable
      ? { ok: true }
      : { ok: false, message: "State database is not reachable" },
  };
  const failed = Object.values(checks).filter((check) => !check.ok).length;
  const state =
    failed === 0 ? "healthy" : failed === Object.keys(checks).length ? "error" : "degraded";

  res.json({
    generated_at: new Date().toISOString(),
    status: { state, checks },
    dispatch: {
      window_days: days,
      dispatched: dispatch?.dispatched ?? null,
      failed: dispatch?.failed ?? null,
      runs: dispatch?.runs ?? null,
      last_dispatch_at: lastDispatch,
      by_channel: dispatch?.by_channel ?? null,
    },
    resolution: {
      // Deliberately null: the resolver cannot produce a true per-recipient
      // rate yet. See docs/atlas-api-plan.md §8.
      fallback_rate: null,
      fallback_events: warnings,
      variables_enabled: variables?.enabled ?? null,
    },
    catalog: {
      variables_total: variables?.total ?? null,
      variables_enabled: variables?.enabled ?? null,
      // Nothing publishes the catalog yet — Atlas pulls it on demand.
      last_published_at: null,
    },
    outbox: {
      pending: outbox ? (outbox.pending ?? 0) + (outbox.delivering ?? 0) : null,
      failed: outbox ? (outbox.failed ?? 0) : null,
    },
  });
}
