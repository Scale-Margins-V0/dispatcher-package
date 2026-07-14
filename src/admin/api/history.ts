/**
 * Dispatch history + failure detail, backed by dispatch_runs /
 * dispatch_recipient_failures / webhook_activity.
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  getActivitySnapshot,
  getDispatchRun,
  listDispatchRuns,
} from "../../db/repos/activity.js";
import type {
  DispatchRunRow,
  RecipientFailureRow,
  WebhookActivityRow,
} from "../../db/schema/index.js";
import { asyncHandler } from "./variables.js";

const listQuerySchema = z.object({
  campaign_id: z.string().max(191).optional(),
  status: z.enum(["accepted", "completed", "failed"]).optional(),
  cursor: z
    .string()
    .regex(/^\d+:[0-9a-f-]+$/i)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function serializeRun(run: DispatchRunRow) {
  return {
    ...run,
    occurred_at: run.occurred_at.toISOString(),
    updated_at: run.updated_at.toISOString(),
  };
}

export function serializeWebhook(row: WebhookActivityRow) {
  return { ...row, occurred_at: row.occurred_at.toISOString() };
}

function serializeRecipientFailure(row: RecipientFailureRow) {
  return { ...row, occurred_at: row.occurred_at.toISOString() };
}

export const registerHistoryRoutes = (app: Express): void => {
  app.get(
    "/admin/api/dispatches",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid dispatch history query" });
        return;
      }
      const { cursor, ...rest } = parsed.data;
      const page = await listDispatchRuns({
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
        dispatches: page.runs.map(serializeRun),
        next_cursor: page.next_cursor
          ? `${page.next_cursor.ts.getTime()}:${page.next_cursor.id}`
          : null,
      });
    })
  );

  app.get(
    "/admin/api/dispatches/:id",
    asyncHandler(async (req: Request, res: Response) => {
      const detail = await getDispatchRun(String(req.params.id));
      if (!detail) {
        res.status(404).json({ error: "Dispatch not found" });
        return;
      }
      res.json({
        dispatch: serializeRun(detail.run),
        recipient_failures: detail.recipient_failures.map(serializeRecipientFailure),
      });
    })
  );

  app.get(
    "/admin/api/failures",
    asyncHandler(async (_req: Request, res: Response) => {
      const snapshot = await getActivitySnapshot();
      res.json({
        generated_at: new Date().toISOString(),
        failures: snapshot.failures.map((item) =>
          "campaign_id" in item && "recipient_count" in item
            ? { kind: "dispatch", ...serializeRun(item as DispatchRunRow) }
            : { kind: "webhook", ...serializeWebhook(item as WebhookActivityRow) }
        ),
      });
    })
  );
};
