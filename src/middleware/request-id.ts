import type { RequestHandler } from "express";
import { logContext } from "../logging/context.js";

/** Assigns a request id, echoes it as X-Request-Id, and opens the log context. */
export const requestIdMiddleware: RequestHandler = (_req, res, next) => {
  const requestId = crypto.randomUUID();
  res.setHeader("X-Request-Id", requestId);
  logContext.run({ request_id: requestId }, next);
};
