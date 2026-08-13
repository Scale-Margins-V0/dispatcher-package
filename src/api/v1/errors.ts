/**
 * One error envelope for the whole /api/v1 tree, so Atlas can branch on a
 * stable `code` rather than parsing prose. Never 500 for an expected
 * condition — a missing metric is null, an unreachable database is a degraded
 * status.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

export type ApiErrorCode =
  | "unauthorized"
  | "not_found"
  | "rate_limited"
  | "unavailable"
  | "internal";

const STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
};

export function apiError(res: Response, code: ApiErrorCode, message: string): void {
  res.status(STATUS[code]).json({ error: code, message });
}

/**
 * Express 4 does not catch rejections from async handlers — an unhandled one
 * becomes a hanging request. Wrap every handler so a throw turns into a clean
 * envelope instead of Express's default HTML 500.
 */
export function asyncApi(handler: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void Promise.resolve(handler(req, res, next)).catch(() => {
      if (!res.headersSent) apiError(res, "internal", "Unexpected error");
    });
  };
}
