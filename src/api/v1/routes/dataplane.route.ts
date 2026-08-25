/**
 * EXTERNAL — the data-plane surface consumed by Atlas.
 *
 * The paths are a frozen contract: the base URL varies per client, the
 * endpoints never do. Additive changes ship in place; removing or retyping a
 * field means a new /api/v2 mounted alongside this one.
 *
 * Middleware order matters and is not incidental:
 *   1. body parsing — scoped to this router, never global (see src/index.ts:
 *      a global JSON parser would consume the raw body that the dispatch
 *      endpoint signs, breaking HMAC verification)
 *   2. access log + rate limit — keyed on the presented credential
 *   3. CORS — before auth, because a preflight carries no credentials and
 *      gating it behind the API key makes every cross-origin call fail 401
 *   4. auth — everything past this point is authenticated
 */

import express, { Router } from "express";
import { componentLogger } from "../../../logging/logger.js";
import { LogComponent } from "../../../logging/conventions.js";
import { requireApiKey } from "../auth.js";
import * as DataPlaneController from "../controllers/dataplane.controller.js";
import { corsMiddleware } from "../cors.js";
import { apiError, asyncApi } from "../errors.js";

const log = componentLogger(LogComponent.apiDataplane);

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

const router = Router();

// 64kb accommodates the largest legitimate definition (8000-char SQL or API
// body plus headers) with room to spare, and still refuses a runaway payload.
router.use(express.json({ limit: "64kb" }));

/**
 * One access log line per request, structured.
 *
 * This is why the handlers below do not each log "request received": every
 * request already produces `method`, `route`, `status_code` and `duration_ms`
 * here. Handlers add only what this cannot see — which validation rule failed,
 * what a write changed, how many rows came back.
 *
 * `route` is the matched pattern (`/variables/:name`), not the concrete path,
 * so "how slow is the variable detail endpoint" is one GROUP BY rather than a
 * scan over thousands of distinct URLs. The concrete path stays in `path`.
 *
 * Only the key's first 12 characters are recorded — enough to tell two
 * integrations apart, never enough to replay one.
 */
router.use((req, res, next) => {
  const started = Date.now();
  const token =
    req.headers.authorization?.replace(/^Bearer\s+/i, "").slice(0, 12) ??
    "none";

  res.on("finish", () => {
    const durationMs = Date.now() - started;
    // A 5xx is ours to fix; a 4xx is the caller's. Only the former is an error.
    const level =
      res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    log[level](
      {
        method: req.method,
        // req.route is only populated once a handler matched — fall back to the path.
        route: `/api/v1/data-plane${req.route?.path ?? req.path}`,
        path: req.originalUrl.split("?")[0],
        status_code: res.statusCode,
        duration_ms: durationMs,
        api_key_prefix: token,
      },
      `${req.method} ${req.originalUrl.split("?")[0]} → ${res.statusCode}`,
    );
  });

  if (rateLimited(token, started)) {
    log.warn(
      { api_key_prefix: token, limit: RATE_LIMIT, window_ms: RATE_WINDOW_MS },
      "Data-plane request rejected — rate limit exceeded",
    );
    apiError(
      res,
      "rate_limited",
      `Rate limit is ${RATE_LIMIT} requests per minute`,
    );
    return;
  }
  next();
});

router.use(corsMiddleware());
router.use(requireApiKey);

/*
 * Observability
 */

router.route("/build").get(asyncApi(DataPlaneController.getBuild));

router.route("/state").get(asyncApi(DataPlaneController.getState));

/*
 * Campaigns — the durable rollup and its per-recipient send log. Read-only:
 * a campaign is something the platform decided, not something authored here.
 */

router.route("/campaigns").get(asyncApi(DataPlaneController.listCampaignsHandler));

router
  .route("/campaigns/:programId")
  .get(asyncApi(DataPlaneController.getCampaignHandler));

router
  .route("/campaigns/:programId/sends")
  .get(asyncApi(DataPlaneController.listCampaignSendsHandler));

/*
 * Logs — the dispatcher's own structured log. Free-form text is PII-scrubbed
 * on the way out; see the controller.
 */

router.route("/logs").get(asyncApi(DataPlaneController.listLogsHandler));

router.route("/logs/:id").get(asyncApi(DataPlaneController.getLogHandler));

/*
 * Variables — the authoring surface. Definitions in, definitions out; a
 * resolved customer value has no route through here.
 */

router
  .route("/variables")
  .get(asyncApi(DataPlaneController.listVariablesHandler))
  .post(asyncApi(DataPlaneController.createVariableHandler));

router
  .route("/variables/:name")
  .get(asyncApi(DataPlaneController.getVariableHandler))
  .patch(asyncApi(DataPlaneController.updateVariableHandler))
  .delete(asyncApi(DataPlaneController.deleteVariableHandler));

// A 404 with the standard envelope, so an Atlas typo reads like every other
// failure instead of Express's default HTML page.
router.use((_req, res) =>
  apiError(res, "not_found", "Unknown data-plane endpoint"),
);

export default router;
