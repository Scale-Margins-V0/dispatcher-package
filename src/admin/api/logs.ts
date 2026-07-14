/**
 * Admin log browsing: persisted structured logs with filters + keyset pagination.
 * Cursor format: "<ts_ms>:<id>".
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { getLogById, queryLogs } from "../../db/repos/logs.js";
import type { AppLogRow } from "../../db/schema/index.js";
import { asyncHandler } from "./variables.js";

const logQuerySchema = z.object({
  level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  campaign_id: z.string().max(191).optional(),
  component: z.string().max(64).optional(),
  q: z.string().max(200).optional(),
  cursor: z
    .string()
    .regex(/^\d+:[0-9a-f-]+$/i)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

function serialize(row: AppLogRow) {
  return {
    ...row,
    ts: row.ts.toISOString(),
  };
}

export const registerLogRoutes = (app: Express): void => {
  app.get(
    "/admin/api/logs",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = logQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid log query" });
        return;
      }
      const { cursor, ...rest } = parsed.data;
      const page = await queryLogs({
        ...rest,
        cursor: cursor
          ? {
              ts: new Date(parseInt(cursor.split(":")[0]!, 10)),
              id: cursor.slice(cursor.indexOf(":") + 1),
            }
          : undefined,
      });
      res.json({
        generated_at: new Date().toISOString(),
        logs: page.logs.map(serialize),
        next_cursor: page.next_cursor
          ? `${page.next_cursor.ts.getTime()}:${page.next_cursor.id}`
          : null,
      });
    })
  );

  app.get(
    "/admin/api/logs/:id",
    asyncHandler(async (req: Request, res: Response) => {
      const row = await getLogById(String(req.params.id));
      if (!row) {
        res.status(404).json({ error: "Log entry not found" });
        return;
      }
      res.json({ log: serialize(row) });
    })
  );
};
