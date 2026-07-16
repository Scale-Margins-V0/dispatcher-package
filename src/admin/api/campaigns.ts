/**
 * Campaign console API: campaign list, per-campaign detail, recipient stage
 * rollups, event feed, dispatch runs, and analytics-forwarding state.
 * Registered behind requireSession. Everything served here is PII-free by
 * construction (opaque user ids, scrubbed metadata, redacted destinations).
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  hasActiveRun,
  listDispatchRuns,
  listRecipientFailuresForUser,
} from "../../db/repos/activity.js";
import {
  getCampaignCallbackRow,
  listCampaignCallbackIds,
} from "../../db/repos/campaign-callbacks.js";
import {
  RECIPIENT_STATUS_ORDER,
  deriveRecipientStatus,
  getCampaignEventAggregates,
  getCampaignFunnel,
  getCampaignRunSummary,
  getRecipientStatusCounts,
  listCampaignChannels,
  listCampaignEvents,
  listCampaignSummaries,
  listProgramSteps,
  listRecipientRollup,
  listUserTimeline,
  type CampaignFunnel,
  type CampaignSummaryRow,
  type RecipientStatus,
} from "../../db/repos/campaign-events.js";
import {
  countOutboxByStatusForProgram,
  listOutboxByProgram,
} from "../../db/repos/outbox.js";
import type { CampaignEventRow, OutboxRow, RecipientFailureRow } from "../../db/schema/index.js";
import { redactDestination } from "../activity.js";
import { serializeRun } from "./history.js";
import { asyncHandler } from "./variables.js";

const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

const EVENT_TYPES = [
  "dispatched",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "unsubscribed",
  "complained",
  "failed",
  "sent",
  "read",
  "deferred",
  "expired",
  "preference_update",
] as const;

/** Campaign/user ids aren't UUIDs — accept any keyset "ts:rest" cursor. */
const cursorSchema = z
  .string()
  .max(230)
  .regex(/^\d+:.+$/s);

const parseCursor = (cursor: string): { ts: Date; rest: string } => ({
  ts: new Date(parseInt(cursor.split(":")[0]!, 10)),
  rest: cursor.slice(cursor.indexOf(":") + 1),
});
const cursorOf = (ts: Date, rest: string): string => `${ts.getTime()}:${rest}`;

const listQuerySchema = z.object({
  q: z.string().max(191).optional(),
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const recipientsQuerySchema = z.object({
  status: z.enum([...RECIPIENT_STATUS_ORDER, "pending"]).optional(),
  q: z.string().max(191).optional(),
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const eventsQuerySchema = z.object({
  event: z.enum(EVENT_TYPES).optional(),
  q: z.string().max(191).optional(),
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const runsQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});

const outboxQuerySchema = z.object({
  status: z.enum(["pending", "delivering", "delivered", "failed"]).optional(),
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});

function serializeEvent(row: CampaignEventRow) {
  return {
    ...row,
    occurred_at: row.occurred_at.toISOString(),
    received_at: row.received_at.toISOString(),
  };
}

function serializeRecipientFailure(row: RecipientFailureRow) {
  return { ...row, occurred_at: row.occurred_at.toISOString() };
}

function serializeOutboxEntry(row: OutboxRow) {
  return {
    id: row.id,
    status: row.status,
    attempts: row.attempts,
    destination: redactDestination(row.callback_url),
    last_error: row.last_error,
    created_at: row.created_at.toISOString(),
    next_attempt_at: row.next_attempt_at.toISOString(),
    delivered_at: row.delivered_at ? row.delivered_at.toISOString() : null,
    /** Scrubbed StandardizedEvent envelope — the raw stored JSON drill-down. */
    event: row.event,
  };
}

function serializeSummary(
  row: CampaignSummaryRow,
  channels: Array<{ program_id: string; channel: string; provider: string }>,
  funnels: Map<string, CampaignFunnel>,
  callbackIds: Set<string>
) {
  const pairs = channels.filter((pair) => pair.program_id === row.program_id);
  return {
    ...row,
    first_activity: row.first_activity.toISOString(),
    last_activity: row.last_activity.toISOString(),
    /** A drip's steps each pick their own channel, so a program can be multi-channel. */
    channels: [...new Set(pairs.map((pair) => pair.channel))],
    providers: [...new Set(pairs.map((pair) => pair.provider))],
    has_callback: callbackIds.has(row.program_id),
    events: funnels.get(row.program_id) ?? null,
  };
}

export const registerCampaignRoutes = (app: Express): void => {
  app.get(
    "/admin/api/campaigns",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid campaigns query" });
        return;
      }
      const { cursor, ...rest } = parsed.data;
      const page = await listCampaignSummaries({
        ...rest,
        cursor: cursor
          ? (() => {
              const c = parseCursor(cursor);
              return { ts: c.ts, program_id: c.rest };
            })()
          : undefined,
      });
      const ids = page.campaigns.map((campaign) => campaign.program_id);
      const [channels, funnels, callbackIds] = await Promise.all([
        listCampaignChannels(ids),
        getCampaignEventAggregates(ids),
        listCampaignCallbackIds(ids),
      ]);
      res.json({
        generated_at: new Date().toISOString(),
        campaigns: page.campaigns.map((row) =>
          serializeSummary(row, channels, funnels as never, callbackIds)
        ),
        next_cursor: page.next_cursor
          ? cursorOf(page.next_cursor.ts, page.next_cursor.program_id)
          : null,
      });
    })
  );

  app.get(
    "/admin/api/campaigns/:id",
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const [summary, funnel, callback, outbox, steps] = await Promise.all([
        getCampaignRunSummary(id),
        getCampaignFunnel(id),
        getCampaignCallbackRow(id),
        countOutboxByStatusForProgram(id),
        listProgramSteps(id),
      ]);
      if (!summary && funnel.unique_recipients === 0 && !callback) {
        res.status(404).json({ error: "Campaign not found" });
        return;
      }
      const pairs = summary ? await listCampaignChannels([id]) : [];
      const active = summary
        ? await hasActiveRun(id, new Date(Date.now() - ACTIVE_WINDOW_MS))
        : false;
      res.json({
        campaign: {
          program_id: id,
          program_kind: summary?.program_kind ?? (id.startsWith("drip_") ? "drip" : "campaign"),
          steps: steps.map((step) => ({
            ...step,
            first_activity: step.first_activity.toISOString(),
            last_activity: step.last_activity.toISOString(),
          })),
          sends: summary?.sends ?? 0,
          organization_id: summary?.organization_id ?? callback?.organization_id ?? null,
          channels: [...new Set(pairs.map((pair) => pair.channel))],
          providers: [...new Set(pairs.map((pair) => pair.provider))],
          runs: summary?.runs ?? 0,
          accepted_runs: summary?.accepted_runs ?? 0,
          failed_runs: summary?.failed_runs ?? 0,
          recipients: summary?.recipients ?? 0,
          sent: summary?.sent ?? 0,
          failed: summary?.failed ?? 0,
          first_activity: summary?.first_activity.toISOString() ?? null,
          last_activity: summary?.last_activity.toISOString() ?? null,
          active,
          callback: callback
            ? {
                registered: true,
                destination: redactDestination(callback.analytics_callback_url),
                last_used_at: callback.last_used_at.toISOString(),
              }
            : null,
          funnel,
          outbox,
        },
      });
    })
  );

  app.get(
    "/admin/api/campaigns/:id/recipients",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = recipientsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid recipients query" });
        return;
      }
      const id = String(req.params.id);
      const { cursor, status, ...rest } = parsed.data;
      const [page, statusCounts] = await Promise.all([
        listRecipientRollup({
          program_id: id,
          status: status as RecipientStatus | undefined,
          ...rest,
          cursor: cursor
            ? (() => {
                const c = parseCursor(cursor);
                return { ts: c.ts, user_id: c.rest };
              })()
            : undefined,
        }),
        getRecipientStatusCounts(id),
      ]);
      res.json({
        generated_at: new Date().toISOString(),
        status_counts: statusCounts,
        recipients: page.recipients.map((row) => ({
          user_id: row.user_id,
          status: row.status,
          stages: {
            dispatched: row.dispatched,
            delivered: row.delivered,
            opened: row.opened,
            clicked: row.clicked,
          },
          flags: {
            bounced: row.bounced,
            complained: row.complained,
            unsubscribed: row.unsubscribed,
            failed: row.failed,
          },
          event_count: row.event_count,
          first_event_at: row.first_event_at.toISOString(),
          last_event_at: row.last_event_at.toISOString(),
        })),
        next_cursor: page.next_cursor
          ? cursorOf(page.next_cursor.ts, page.next_cursor.user_id)
          : null,
      });
    })
  );

  app.get(
    "/admin/api/campaigns/:id/recipients/:userId",
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const userId = String(req.params.userId);
      const [events, failures] = await Promise.all([
        listUserTimeline(id, userId),
        listRecipientFailuresForUser(id, userId),
      ]);
      if (events.length === 0 && failures.length === 0) {
        res.status(404).json({ error: "No activity for this recipient" });
        return;
      }
      const flags: Record<string, boolean> = {};
      for (const event of events) {
        flags[event.event === "read" ? "opened" : event.event] = true;
      }
      if (failures.length > 0) flags.failed = true;
      res.json({
        program_id: id,
        user_id: userId,
        status: deriveRecipientStatus(flags),
        events: events.map(serializeEvent),
        recipient_failures: failures.map(serializeRecipientFailure),
      });
    })
  );

  app.get(
    "/admin/api/campaigns/:id/events",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = eventsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid events query" });
        return;
      }
      const { cursor, ...rest } = parsed.data;
      const page = await listCampaignEvents({
        program_id: String(req.params.id),
        ...rest,
        cursor: cursor
          ? (() => {
              const c = parseCursor(cursor);
              return { ts: c.ts, id: c.rest };
            })()
          : undefined,
      });
      res.json({
        generated_at: new Date().toISOString(),
        events: page.events.map(serializeEvent),
        next_cursor: page.next_cursor
          ? cursorOf(page.next_cursor.ts, page.next_cursor.id)
          : null,
      });
    })
  );

  app.get(
    "/admin/api/campaigns/:id/runs",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = runsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid runs query" });
        return;
      }
      const { cursor, limit } = parsed.data;
      const page = await listDispatchRuns({
        program_id: String(req.params.id),
        limit,
        cursor: cursor
          ? (() => {
              const c = parseCursor(cursor);
              return { ts: c.ts, id: c.rest };
            })()
          : undefined,
      });
      res.json({
        generated_at: new Date().toISOString(),
        dispatches: page.runs.map(serializeRun),
        next_cursor: page.next_cursor
          ? cursorOf(page.next_cursor.ts, page.next_cursor.id)
          : null,
      });
    })
  );

  app.get(
    "/admin/api/campaigns/:id/outbox",
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = outboxQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid outbox query" });
        return;
      }
      const id = String(req.params.id);
      const { cursor, ...rest } = parsed.data;
      const [page, statusCounts] = await Promise.all([
        listOutboxByProgram({
          program_id: id,
          ...rest,
          cursor: cursor
            ? (() => {
                const c = parseCursor(cursor);
                return { ts: c.ts, id: c.rest };
              })()
            : undefined,
        }),
        countOutboxByStatusForProgram(id),
      ]);
      res.json({
        generated_at: new Date().toISOString(),
        status_counts: statusCounts,
        entries: page.rows.map(serializeOutboxEntry),
        next_cursor: page.next_cursor
          ? cursorOf(page.next_cursor.ts, page.next_cursor.id)
          : null,
      });
    })
  );

  // Run detail (+ per-run recipient failures) is GET /admin/api/dispatches/:id
  // from history.ts — the Runs tab reuses it as-is.
};
