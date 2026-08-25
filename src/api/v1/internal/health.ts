/**
 * Internal ops endpoints. No auth — this router is expected to be reachable
 * only from inside the client's network, unlike the external one.
 *
 * Liveness and readiness are deliberately separate. Conflating them is a
 * classic outage amplifier: a readiness failure (database briefly unreachable)
 * answering a *liveness* probe gets the container killed, which does not fix a
 * database problem and removes capacity while it is happening.
 */

import type { Request, Response } from "express";
import { isDbInitialized } from "../../../db/client.js";
import { stateDatabaseReachable } from "../../../db/repos/stats.js";
import { getRuntimeStatus } from "../../../ops/diagnostics.js";

/** Liveness — the process is up and serving. Never touches a dependency. */
export function healthHandler(_req: Request, res: Response): void {
  res.json({ status: "ok" });
}

/** Readiness — this instance can actually do useful work right now. */
export async function readyHandler(_req: Request, res: Response): Promise<void> {
  const runtime = getRuntimeStatus();
  const database = isDbInitialized() && (await stateDatabaseReachable());
  const configOk = runtime.checks.dispatch_config.ok && runtime.checks.event_config.ok;
  const ready = database && configOk && runtime.checks.required_env.ok;

  res.status(ready ? 200 : 503).json({
    ready,
    checks: {
      required_env: runtime.checks.required_env.ok,
      dispatch_config: runtime.checks.dispatch_config.ok,
      event_config: runtime.checks.event_config.ok,
      state_database: database,
    },
  });
}
