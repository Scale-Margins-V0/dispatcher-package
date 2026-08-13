/**
 * GET /api/v1/data-plane/build — identity and environment.
 *
 * Cheap and dependency-light, which is why Atlas uses it as the connection
 * probe: a 200 proves both reachability and authentication before a connection
 * is saved.
 *
 * Emits the database *dialect*, never its URL, host, user or password. The
 * dialect is operationally useful; the connection string is a credential.
 */

import type { Request, Response } from "express";
import { resolveDbEnv } from "../../../db/env.js";
import { lastDispatchAt, stateDatabaseReachable } from "../../../db/repos/stats.js";
import { isDbInitialized } from "../../../db/client.js";
import { getBuildInfo } from "../../../ops/build-info.js";
import { API_VERSION } from "../version.js";

export async function buildHandler(_req: Request, res: Response): Promise<void> {
  const build = getBuildInfo();
  const reachable = await stateDatabaseReachable();

  res.json({
    generated_at: new Date().toISOString(),
    service: {
      name: build.name,
      version: build.version,
      git_sha: build.git_sha,
      build_time: build.build_time,
      image_tag: build.image_tag,
      api_version: API_VERSION,
    },
    runtime: {
      environment: build.environment,
      node_version: build.node_version,
      uptime_seconds: build.uptime_seconds,
    },
    database: {
      dialect: resolveDbEnv(process.env).dialect,
      reachable,
      migrations_applied: isDbInitialized(),
    },
    last_dispatch_at: await lastDispatchAt(),
  });
}
