/**
 * POST /api/scalemargin/client-events — the company's own systems reporting
 * what happened to a message the dispatcher sent (a click on its site, a read
 * seen in its app, …). Built like the provider webhooks: raw body, a shared
 * secret (Bearer token or HMAC signature), and the events are forwarded to
 * ScaleMargin as receipts for the message — the same path Freshchat uses, so
 * skipped steps are filled in and nothing already reported is sent twice.
 *
 * A message is named either by its Freshchat `request_id`, or by a value an
 * api variable saved with it (api_response_refs) — narrowed by user, campaign,
 * organization or dispatch id when the value alone is not unique.
 *
 * Off (404) until events.client_webhook_secret is set: an open endpoint that
 * writes analytics would let anyone forge clicks.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { z } from "zod";
import { findMessagesBySavedValue, findSentMessages, type SentMessage } from "../../db/repos/api-response-refs.js";
import { isDbInitialized } from "../../db/state.js";
import { componentLogger } from "../../logging/logger.js";
import type { AnalyticsEventType } from "../../providers/types.js";
import { mapFreshchatStatus, type FreshchatReceipt } from "../freshchat/adapter.js";
import { forwardFreshchatReceiptsIsolating } from "../freshchat/receipt-forwarder.js";
import { MAX_RECEIPTS_PER_REQUEST, reconcileWebhookReceipts, recordReportedStatuses } from "../freshchat/status-poller.js";

const log = componentLogger("events.client");

export const CLIENT_EVENTS_SECRET_SETTING = "CLIENT_EVENTS_WEBHOOK_SECRET";
/** Only Freshchat sends record a request id and saved values today. */
const PROVIDER = "freshchat";
export const MAX_CLIENT_EVENTS = 500;

const optionalId = z.string().trim().min(1).max(191).optional();
const clientEventSchema = z
  .object({
    event: z.string().trim().min(1, "event is required"),
    occurred_at: z
      .string()
      .refine((s) => !Number.isNaN(Date.parse(s)), "occurred_at must be an ISO 8601 time")
      .optional(),
    request_id: optionalId,
    variable_name: optionalId,
    path: optionalId,
    value: optionalId,
    user_id: optionalId,
    campaign_id: optionalId,
    organization_id: optionalId,
    dispatch_id: optionalId,
    cause: z.string().max(500).optional(),
    error_code: z.string().max(100).optional(),
  })
  // The other columns of a saved row (template_name, sender_id, …) may be sent
  // back as-is; they are not needed to find the message and are ignored.
  .passthrough();
type ClientEvent = z.infer<typeof clientEventSchema>;

/**
 * Events a client may report. Analytics names or Freshchat-style statuses;
 * `dispatched` is refused — the send already reported it.
 */
export function clientEventType(raw: string): AnalyticsEventType | null {
  const name = raw.trim().toLowerCase();
  if (name === "delivered" || name === "read" || name === "clicked" || name === "bounced") return name;
  const mapped = mapFreshchatStatus(raw);
  return mapped && mapped !== "dispatched" ? mapped : null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Bearer secret, or an HMAC-SHA256 of the raw body keyed with it. */
export function verifyClientEventsRequest(req: Pick<Request, "headers">, rawBody: Buffer, secret: string): boolean {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ") && constantTimeEqual(auth.slice(7).trim(), secret)) return true;
  const sig = req.headers["x-scalemargin-signature"];
  if (typeof sig !== "string") return false;
  const given = sig.startsWith("sha256=") ? sig.slice(7).trim() : sig.trim();
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return constantTimeEqual(given.toLowerCase(), expected);
}

export type ClientEventResult = {
  index: number;
  status: "forwarded" | "already_reported" | "rejected" | "not_found" | "ambiguous" | "invalid";
  request_id?: string;
  error?: string;
};

/** Which message an event is about, or why it can't be told. */
async function resolveMessage(
  e: ClientEvent
): Promise<{ ok: true; message: SentMessage } | { ok: false; status: ClientEventResult["status"]; error: string }> {
  if (e.request_id) {
    const [message] = await findSentMessages(PROVIDER, [e.request_id]);
    if (!message) return { ok: false, status: "not_found", error: "No message was sent with this request_id (or it is past message_id_ttl)" };
    if (e.user_id && e.user_id !== message.user_id) {
      return { ok: false, status: "not_found", error: "This request_id was sent to a different user_id" };
    }
    return { ok: true, message };
  }
  if (e.variable_name && e.path && e.value) {
    const found = await findMessagesBySavedValue({
      provider: PROVIDER,
      variable_name: e.variable_name,
      path: e.path,
      value: e.value,
      user_id: e.user_id,
      campaign_id: e.campaign_id,
      organization_id: e.organization_id,
      dispatch_id: e.dispatch_id,
    });
    if (found.length === 0) return { ok: false, status: "not_found", error: "No message was sent with this saved value (or it is past message_id_ttl)" };
    if (found.length > 1) {
      return { ok: false, status: "ambiguous", error: "This value was sent with more than one message — add user_id, campaign_id or dispatch_id" };
    }
    return { ok: true, message: found[0]! };
  }
  return { ok: false, status: "invalid", error: "Name the message: request_id, or variable_name + path + value" };
}

function eventsOf(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const events = (body as { events?: unknown }).events;
    return Array.isArray(events) ? events : [body];
  }
  return null;
}

export function createClientEventsHandler(): RequestHandler {
  return async (req, res) => {
    const secret = process.env[CLIENT_EVENTS_SECRET_SETTING]?.trim();
    if (!secret) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const rawBody = Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}), "utf-8");
    if (!verifyClientEventsRequest(req, rawBody, secret)) {
      log.warn({ error_category: "unauthenticated_webhook" }, "Client events rejected — wrong or missing secret");
      res.status(401).json({ error: "invalid signature" });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString("utf-8"));
    } catch {
      res.status(400).json({ error: "Invalid JSON" });
      return;
    }
    const items = eventsOf(body);
    if (!items || items.length === 0) {
      res.status(400).json({ error: "Send one event, an array of events, or { events: [...] }" });
      return;
    }
    if (items.length > MAX_CLIENT_EVENTS) {
      res.status(413).json({ error: `At most ${MAX_CLIENT_EVENTS} events per request` });
      return;
    }
    if (!isDbInitialized()) {
      res.status(503).json({ error: "The dispatcher's state database is required to match events to messages" });
      return;
    }

    const results: ClientEventResult[] = [];
    const receipts: Array<{ index: number; receipt: FreshchatReceipt }> = [];
    for (const [index, item] of items.entries()) {
      const parsed = clientEventSchema.safeParse(item);
      if (!parsed.success) {
        results.push({ index, status: "invalid", error: parsed.error.issues.map((i) => `${i.path.join(".") || "event"}: ${i.message}`).join("; ") });
        continue;
      }
      const e = parsed.data;
      const event = clientEventType(e.event);
      if (!event) {
        results.push({ index, status: "invalid", error: `Unknown event "${e.event}" — use delivered, read, clicked or failed` });
        continue;
      }
      const found = await resolveMessage(e);
      if (!found.ok) {
        results.push({ index, status: found.status, error: found.error });
        continue;
      }
      const request_id = found.message.provider_message_id;
      receipts.push({
        index,
        receipt: {
          external_id: request_id,
          event,
          occurred_at: e.occurred_at ? new Date(e.occurred_at).toISOString() : new Date().toISOString(),
          provider: PROVIDER,
          ...(event === "bounced" && e.cause ? { cause: e.cause } : {}),
          ...(event === "bounced" && e.error_code ? { error_code: e.error_code } : {}),
        },
      });
      results.push({ index, status: "forwarded", request_id });
    }

    // Same path as the Freshchat webhook: drop steps already reported, fill in skipped ones.
    const toForward = await reconcileWebhookReceipts(receipts.map((r) => r.receipt));
    const sent = new Set(toForward.map((r) => `${r.external_id}|${r.event}`));
    for (const r of receipts) {
      if (!sent.has(`${r.receipt.external_id}|${r.receipt.event}`)) {
        const result = results.find((x) => x.index === r.index)!;
        result.status = "already_reported";
      }
    }
    const refusedByMessage = new Map<string, string>();
    for (let i = 0; i < toForward.length; i += MAX_RECEIPTS_PER_REQUEST) {
      const batch = toForward.slice(i, i + MAX_RECEIPTS_PER_REQUEST);
      // A receipt refused on its own (its campaign or step was deleted) is
      // reported per event as `rejected`; the rest of the batch still goes.
      const forwarded = await forwardFreshchatReceiptsIsolating(batch, process.env.SCALEMARGIN_ANALYTICS_SECRET ?? "");
      if (forwarded.accepted.length > 0) await recordReportedStatuses(forwarded.accepted);
      for (const r of forwarded.rejected) refusedByMessage.set(r.receipt.external_id, r.error);
      if (forwarded.failed.length > 0) {
        log.warn({ receipts: forwarded.failed.length, error: forwarded.error }, "Client events could not be forwarded to ScaleMargin");
        res.status(502).json({ error: "ScaleMargin did not accept the events — retry", retryable: true, results: results.sort((a, b) => a.index - b.index) });
        return;
      }
    }
    for (const r of receipts) {
      const refusal = refusedByMessage.get(r.receipt.external_id);
      const result = results.find((x) => x.index === r.index)!;
      if (refusal !== undefined && result.status === "forwarded") {
        result.status = "rejected";
        result.error = `ScaleMargin refused it: ${refusal.slice(0, 200)}`;
      }
    }

    const tally = (s: ClientEventResult["status"]) => results.filter((r) => r.status === s).length;
    log.info(
      { received: items.length, forwarded: tally("forwarded"), already_reported: tally("already_reported"), rejected: tally("rejected"), not_found: tally("not_found"), ambiguous: tally("ambiguous"), invalid: tally("invalid") },
      "Client events processed"
    );
    res.status(200).json({ received: items.length, receipts: toForward.length, results: results.sort((a, b) => a.index - b.index) });
  };
}
