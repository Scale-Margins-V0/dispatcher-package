/**
 * Mount point for the /api/v1 tree. Two routers, side by side, with opposite
 * change policies — see routes/dataplane.route.ts and routes/internal.route.ts
 * for what each one guarantees.
 *
 *   /api/v1/data-plane  EXTERNAL — Atlas. API-key auth. Frozen path contract.
 *   /api/v1/internal    INTERNAL — the client's own probes. No auth.
 *
 * Body parsing lives inside each router, never here and never globally: a
 * global JSON parser would consume the raw body that
 * `POST /api/scalemargin/dispatch` signs, breaking HMAC verification.
 */

import type { Express } from "express";
import { componentLogger } from "../../logging/logger.js";
import { atlasKeyWarning } from "./atlas-key.js";
import { allowedOrigins, corsWarning } from "./cors.js";
import dataPlaneRouter from "./routes/dataplane.route.js";
import internalRouter from "./routes/internal.route.js";

export { resetApiRateLimitForTests } from "./routes/dataplane.route.js";

const log = componentLogger("api.external");

export function registerApiV1Routes(app: Express): void {
  if (process.env.VITEST !== "true") {
    for (const warning of [atlasKeyWarning(), corsWarning()]) {
      if (warning) log.warn(`[api] ${warning}`);
    }
    const origins = allowedOrigins();
    log.info(
      origins.length > 0
        ? `[api] Atlas API CORS enabled for: ${origins.join(", ")}`
        : "[api] Atlas API CORS disabled (server-to-server only)"
    );
  }

  app.use("/api/v1/data-plane", dataPlaneRouter);
  app.use("/api/v1/internal", internalRouter);
}
