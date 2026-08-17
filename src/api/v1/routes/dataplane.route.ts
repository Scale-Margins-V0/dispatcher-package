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
import { requireApiKey } from "../auth.js";
import * as DataPlaneController from "../controllers/dataplane.controller.js";
import { corsMiddleware } from "../cors.js";
import { apiError, asyncApi } from "../errors.js";

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

const router = Router();

// 64kb accommodates the largest legitimate definition (8000-char SQL or API
// body plus headers) with room to spare, and still refuses a runaway payload.
router.use(express.json({ limit: "64kb" }));

router.use((req, res, next) => {
  const started = Date.now();
  const token =
    req.headers.authorization?.replace(/^Bearer\s+/i, "").slice(0, 12) ??
    "none";
  res.on("finish", () => {
    log.info(
      `[api] ${req.method} ${req.originalUrl} key=${token} status=${
        res.statusCode
      } ${Date.now() - started}ms`,
    );
  });
  if (rateLimited(token, started)) {
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
