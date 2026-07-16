/**
 * Public GET /logs — a query-driven, bearer-authenticated view of the persisted
 * structured logs (separate from the session-gated admin console endpoint).
 * Reuses queryLogs() from the state DB.
 */

import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { getAuth, isAuthInitialized } from "./auth/index.js";
import { bearerFromRequest, verifyApiKey } from "./auth/api-keys.js";
import { queryLogs } from "./db/repos/logs.js";
import type { AppLogRow, LogLevel } from "./db/schema/index.js";
import { isDbInitialized } from "./db/state.js";
import { verifyLogsToken } from "./logging/logs-token.js";

const LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

/** Levels at or above the given one (for `min_level`). */
function levelsAtLeast(min: LogLevel): LogLevel[] {
  return LEVELS.slice(LEVELS.indexOf(min));
}

/** Parse a relative window like "15m" / "2h" / "7d" into a Date in the past. */
function parseSince(value: string): Date | undefined {
  const m = /^(\d+)\s*(s|m|h|d)$/i.exec(value.trim());
  if (!m) return undefined;
  const n = parseInt(m[1]!, 10);
  const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]!.toLowerCase()]!;
  return new Date(Date.now() - n * unit);
}

const querySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  since: z.string().max(16).optional(),
  level: z.enum(LEVELS as [LogLevel, ...LogLevel[]]).optional(),
  min_level: z.enum(LEVELS as [LogLevel, ...LogLevel[]]).optional(),
  component: z.string().max(64).optional(),
  campaign_id: z.string().max(191).optional(),
  request_id: z.string().max(64).optional(),
  q: z.string().max(200).optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  cursor: z
    .string()
    .regex(/^\d+:[0-9a-f-]+$/i)
    .optional(),
});

async function isAuthorized(req: Request): Promise<boolean> {
  const bearer = bearerFromRequest(req.header("authorization"));
  if (bearer && ((await verifyApiKey(bearer)) || (await verifyLogsToken(bearer)))) return true;
  // Fall back to a valid admin session (cookie) for console/curl convenience.
  if (isAuthInitialized()) {
    try {
      const session = await getAuth().api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (session?.user) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

const requireLogsApiAuth: RequestHandler = (req, res, next: NextFunction): void => {
  void isAuthorized(req)
    .then((ok) => {
      if (ok) return next();
      res.setHeader("WWW-Authenticate", "Bearer");
      res.status(401).json({ error: "Unauthorized — provide a valid Bearer token" });
    })
    .catch(() => res.status(500).json({ error: "Auth check failed" }));
};

function serialize(row: AppLogRow) {
  return { ...row, ts: row.ts.toISOString() };
}

export const registerLogsApiRoutes = (app: Express): void => {
  app.get(
    "/logs",
    requireLogsApiAuth,
    (req: Request, res: Response): void => {
      if (!isDbInitialized()) {
        res.status(503).json({ error: "Log store not ready" });
        return;
      }
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid log query",
          details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
        return;
      }
      const d = parsed.data;
      const from = d.from ?? (d.since ? parseSince(d.since) : undefined);
      void queryLogs({
        limit: d.limit,
        order: d.order,
        ...(d.level ? { level: d.level } : d.min_level ? { levels: levelsAtLeast(d.min_level) } : {}),
        ...(from ? { from } : {}),
        ...(d.to ? { to: d.to } : {}),
        ...(d.component ? { component: d.component } : {}),
        ...(d.campaign_id ? { campaign_id: d.campaign_id } : {}),
        ...(d.request_id ? { request_id: d.request_id } : {}),
        ...(d.q ? { q: d.q } : {}),
        ...(d.cursor
          ? {
              cursor: {
                ts: new Date(parseInt(d.cursor.split(":")[0]!, 10)),
                id: d.cursor.slice(d.cursor.indexOf(":") + 1),
              },
            }
          : {}),
      })
        .then((page) => {
          res.json({
            generated_at: new Date().toISOString(),
            count: page.logs.length,
            logs: page.logs.map(serialize),
            next_cursor: page.next_cursor
              ? `${page.next_cursor.ts.getTime()}:${page.next_cursor.id}`
              : null,
          });
        })
        .catch(() => res.status(500).json({ error: "Failed to query logs" }));
    }
  );
};
