/**
 * INTERNAL — consumed by the client's own infrastructure (liveness probes,
 * deploy smoke tests). No auth, no CORS, expected to be network-restricted.
 * Free to change: nothing outside the client's network reads it.
 */

import { Router } from "express";
import { apiError, asyncApi } from "../errors.js";
import { healthHandler, readyHandler } from "../internal/health.js";

const router = Router();

router.route("/health").get(healthHandler);
router.route("/ready").get(asyncApi(readyHandler));

router.use((_req, res) => apiError(res, "not_found", "Unknown internal endpoint"));

export default router;
