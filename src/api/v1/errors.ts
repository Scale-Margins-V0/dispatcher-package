/**
 * One error envelope for the whole /api/v1 tree, so Atlas can branch on a
 * stable `code` rather than parsing prose. Never 500 for an expected
 * condition — a missing metric is null, an unreachable database is a degraded
 * status.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodError } from "zod";

export type ApiErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "unavailable"
  | "internal";

const STATUS: Record<ApiErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
};

/** One field-level complaint, so a form can highlight the input that failed. */
export type ApiErrorDetail = { path: string; message: string };

export function apiError(
  res: Response,
  code: ApiErrorCode,
  message: string,
  details?: ApiErrorDetail[]
): void {
  res.status(STATUS[code]).json({
    error: code,
    message,
    ...(details && details.length > 0 ? { details } : {}),
  });
}

/**
 * Zod issue paths carry numeric indices and the union discriminator; joining
 * with dots keeps them addressable from a client (`definition.api.url`)
 * without leaking the schema's internal structure.
 */
export function zodDetails(error: ZodError): ApiErrorDetail[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

export function invalidRequest(res: Response, error: ZodError): void {
  apiError(res, "invalid_request", "Request failed validation", zodDetails(error));
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
