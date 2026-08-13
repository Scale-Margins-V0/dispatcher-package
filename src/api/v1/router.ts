/**
 * Two routers, mounted side by side, with opposite change policies.
 *
 *   /api/v1/data-plane  EXTERNAL — consumed by Atlas. API-key auth. The paths
 *                       are a frozen contract: the base URL varies per client,
 *                       the endpoints never do. Breaking changes need /api/v2.
 *
 *   /api/v1/internal    INTERNAL — consumed by the client's own infrastructure
 *                       (probes, deploy smoke tests). No auth, expected to be
 *                       network-restricted. Free to change.
 *
 * Body parsing is scoped to this tree ONLY. A global JSON parser would consume
 * the raw body that `POST /api/scalemargin/dispatch` signs, breaking HMAC
 * verification — see src/index.ts.
 */

import express, { Router, type Express } from "express";
import { componentLogger } from "../../logging/logger.js";
import { atlasKeyWarning } from "./atlas-key.js";
import { requireApiKey } from "./auth.js";
import { allowedOrigins, corsMiddleware, corsWarning } from "./cors.js";
import { apiError, asyncApi } from "./errors.js";
import { buildHandler } from "./external/build.js";
import { stateHandler } from "./external/state.js";
import { healthHandler, readyHandler } from "./internal/health.js";

const log = componentLogger("api.external");

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

// ponytail: in-process fixed-window limiter, per replica. The event outbox
// already mandates a single replica; move to the state DB only if that changes.
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(key: string, now: number): boolean {
  const entry = hits.get(key);
  if (!entry || now >= entry.resetAt) {
    hits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

export function resetApiRateLimitForTests(): void {
  hits.clear();
}

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

  const external = Router();
  const internal = Router();

  // Server-to-server only. A browser must never hold this key, so no CORS.
  external.use(express.json({ limit: "16kb" }));

  external.use((req, res, next) => {
    const started = Date.now();
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "").slice(0, 12) ?? "none";
    res.on("finish", () => {
      log.info(
        `[api] ${req.method} ${req.originalUrl} key=${token} status=${res.statusCode} ${Date.now() - started}ms`
      );
    });
    if (rateLimited(token, started)) {
      apiError(res, "rate_limited", `Rate limit is ${RATE_LIMIT} requests per minute`);
      return;
    }
    next();
  });

  // Before auth: a preflight carries no credentials, so gating it behind the
  // API key makes every legitimate cross-origin call fail with a 401.
  external.use(corsMiddleware());

  external.use(requireApiKey);

  external.get("/state", asyncApi(stateHandler));
  external.get("/build", asyncApi(buildHandler));
  external.use((_req, res) => apiError(res, "not_found", "Unknown data-plane endpoint"));

  internal.get("/health", healthHandler);
  internal.get("/ready", asyncApi(readyHandler));
  internal.use((_req, res) => apiError(res, "not_found", "Unknown internal endpoint"));

  app.use("/api/v1/data-plane", external);
  app.use("/api/v1/internal", internal);
}
