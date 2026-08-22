/**
 * API-key gate for the external (Atlas) router.
 *
 * The credential is `DISPATCHER_ATLAS_KEY` from the environment — see
 * ./atlas-key.ts. The console-managed `api_keys` table is a different
 * credential for a different surface (/logs) and is not accepted here.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { bearerFromRequest } from "../../auth/api-keys.js";
import { componentLogger } from "../../logging/logger.js";
import { ATLAS_KEY_ENV, isAtlasApiConfigured, verifyAtlasKey } from "./atlas-key.js";
import { apiError } from "./errors.js";

const log = componentLogger("api.external");

/**
 * One failure message for every rejection reason. Distinguishing "no key" from
 * "wrong key" in the response is an oracle; the detail goes to the log instead.
 */
export const requireApiKey: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Fail closed. An unconfigured deployment must not serve the API to anyone,
  // and this is the one case worth distinguishing in the response — it is an
  // operator error on our side, not a bad credential on the caller's.
  if (!isAtlasApiConfigured()) {
    log.warn(
      `[api] ${req.method} ${req.path} — refused: ${ATLAS_KEY_ENV} is not set`
    );
    apiError(
      res,
      "unavailable",
      `Atlas API is not configured on this dispatcher (${ATLAS_KEY_ENV} is unset)`
    );
    return;
  }

  const presented = bearerFromRequest(req.headers.authorization);
  if (!presented || !verifyAtlasKey(presented)) {
    log.warn(
      `[api] ${req.method} ${req.path} — rejected (${presented ? "key mismatch" : "no bearer token"})`
    );
    apiError(res, "unauthorized", "Valid API key required");
    return;
  }

  next();
};
