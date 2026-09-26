/**
 * Freshchat status poller — the webhook's job, done by asking.
 *
 * For a Freshchat sender with `status_poller: true`, every accepted send is
 * queued in `provider_message_ids` (`next_poll_at` set). Each tick asks
 * Freshchat's status API about the messages that are due:
 *
 *   GET {host}/v2/outbound-messages?request_id=<request_id>
 *
 * and when a message's status moves FORWARD (dispatched → delivered → read, or
 * → failed) it forwards the same receipt a webhook would — `{ channel:
 * "whatsapp", receipts: [...] }` to ScaleMargin's campaign-analytics endpoint,
 * matched there by `request_id`.
 *
 * Rules that keep it correct and cheap:
 *
 *   - **Forward only real progress.** The last reported event is stored per
 *     message; a status that is not further along (or a repeat) is saved but
 *     not forwarded. Webhook receipts update the same field
 *     (recordReportedStatuses), so running both never double-reports.
 *   - **At least once.** The new status is persisted only after ScaleMargin
 *     accepted the receipt; if forwarding fails, the next poll sees the change
 *     again and retries.
 *   - **Stop when done.** READ and FAILED are final — polling ends. Anything
 *     older than dispatcher.retention.freshchat_status_poll_ttl stops too.
 *   - **Back off with age.** A message is polled every interval while fresh,
 *     6× less often after 15 minutes and 30× after 2 hours — an unread message
 *     is not worth 25,000 API calls over three days.
 *   - **Respect the API.** 429 pauses that sender until Retry-After; 401/403
 *     pauses it for five minutes and says why, once. Few requests in flight.
 *
 * Single replica, like the event outbox: two pollers on one state database
 * would each forward the same change once.
 */

import { freshchatConfigFromSender } from "../../providers/freshchat-whatsapp.js";
import { registry } from "../../providers/senders.js";
import type { SenderConfig } from "../../providers/types.js";
import {
  expirePolls,
  findByProviderMessageIds,
  listDuePolls,
  updatePoll,
  type PollRow,
} from "../../db/repos/provider-message-ids.js";
import { isDbInitialized } from "../../db/client.js";
import { describeStatusPollTtl, statusPollTtl } from "../../config/status-poll-ttl.js";
import { componentLogger } from "../../logging/logger.js";
import { mapFreshchatStatus, type FreshchatReceipt } from "./adapter.js";
import { forwardFreshchatReceipts } from "./receipt-forwarder.js";

const log = componentLogger("events.freshchat.poller");

const PROVIDER = "freshchat";
export const DEFAULT_POLL_INTERVAL_SECONDS = 10;
/** Messages asked about per tick, across all senders. */
const BATCH_LIMIT = 200;
/** Requests in flight at once. */
const CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 10_000;
const AUTH_PAUSE_MS = 5 * 60_000;
/** Backend cap on receipts per request (dispatch_receipts.ts). */
const FORWARD_CHUNK = 500;

// ── Pure helpers ──────────────────────────────────────────────────────────

/** How far along an analytics event is. `null` (nothing reported yet) = dispatched. */
const RANK: Record<string, number> = { dispatched: 1, delivered: 2, read: 3, bounced: 3, clicked: 4 };
export function statusRank(event: string | null | undefined): number {
  return event ? (RANK[event] ?? 0) : 1;
}
/** Events after which Freshchat reports nothing new worth asking about. */
export function isFinalEvent(event: string | null | undefined): boolean {
  return event === "read" || event === "bounced" || event === "clicked";
}

/** The sender's poll interval, in ms. */
export function pollIntervalMs(sender: SenderConfig): number {
  return (sender.freshchat?.status_poll_interval_seconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000;
}

/** Delay before the next poll: the interval while fresh, then less often as the message ages. */
export function nextPollDelayMs(intervalMs: number, ageMs: number): number {
  if (ageMs < 15 * 60_000) return intervalMs;
  if (ageMs < 2 * 60 * 60_000) return intervalMs * 6;
  return intervalMs * 30;
}

/**
 * The status endpoint beside the send endpoint:
 * `https://x.freshchat.com/v2/outbound-messages/whatsapp` →
 * `https://x.freshchat.com/v2/outbound-messages?request_id=…`.
 */
export function freshchatStatusUrl(sendEndpoint: string, requestId: string): string {
  const url = new URL(sendEndpoint);
  const path = url.pathname.replace(/\/+$/, "");
  const idx = path.indexOf("/outbound-messages");
  url.pathname = idx >= 0 ? path.slice(0, idx + "/outbound-messages".length) : "/v2/outbound-messages";
  url.search = "";
  url.searchParams.set("request_id", requestId);
  return url.toString();
}

export type StatusLookup =
  | { kind: "status"; status: string; messageId?: string; cause?: string; errorCode?: string }
  | { kind: "unknown" }
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "auth"; httpStatus: number }
  | { kind: "error"; message: string };

/** The outbound_messages entry for this request_id, from a status API body. */
export function parseStatusResponse(body: unknown, requestId: string): StatusLookup {
  const list = (body as { outbound_messages?: unknown })?.outbound_messages;
  if (!Array.isArray(list) || list.length === 0) return { kind: "unknown" };
  const match =
    (list.find((m) => (m as { request_id?: unknown })?.request_id === requestId) as Record<string, unknown> | undefined) ??
    (list[0] as Record<string, unknown>);
  const status = typeof match?.status === "string" ? match.status.trim() : "";
  if (!status) return { kind: "unknown" };
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = match[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number") return String(v);
    }
    return undefined;
  };
  return {
    kind: "status",
    status: status.toUpperCase(),
    ...(pick("message_id") ? { messageId: pick("message_id") } : {}),
    ...(pick("failure_reason", "error_message", "reason") ? { cause: pick("failure_reason", "error_message", "reason") } : {}),
    ...(pick("failure_code", "error_code", "code") ? { errorCode: pick("failure_code", "error_code", "code") } : {}),
  };
}

function retryAfterMs(header: string | null): number {
  const secs = Number(header);
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 15 * 60_000);
  const at = header ? Date.parse(header) : NaN;
  if (Number.isFinite(at)) return Math.max(1000, Math.min(at - Date.now(), 15 * 60_000));
  return 60_000;
}

export async function lookupStatus(
  apiKey: string,
  sendEndpoint: string,
  requestId: string,
  doFetch: typeof fetch = fetch
): Promise<StatusLookup> {
  let res: Response;
  try {
    res = await doFetch(freshchatStatusUrl(sendEndpoint, requestId), {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  if (res.status === 429) return { kind: "rate_limited", retryAfterMs: retryAfterMs(res.headers.get("retry-after")) };
  if (res.status === 401 || res.status === 403) return { kind: "auth", httpStatus: res.status };
  if (res.status === 404) return { kind: "unknown" };
  if (!res.ok) return { kind: "error", message: `status API HTTP ${res.status}` };
  try {
    return parseStatusResponse(await res.json(), requestId);
  } catch {
    return { kind: "error", message: "status API returned invalid JSON" };
  }
}

// ── Which senders ─────────────────────────────────────────────────────────

/** Enabled Freshchat senders with the poller on. */
export function pollingSenders(): SenderConfig[] {
  return registry
    .getAllSenders()
    .map((s) => s.config)
    .filter((c) => c.provider === PROVIDER && c.freshchat?.status_poller === true);
}

/** When a message just sent by `sender` should first be polled — null if never. */
export function initialPollAt(sender: SenderConfig | undefined, now = new Date()): Date | null {
  if (!sender || sender.provider !== PROVIDER || sender.freshchat?.status_poller !== true) return null;
  return new Date(now.getTime() + pollIntervalMs(sender));
}

// ── Keeping webhook and poller in step ────────────────────────────────────

/**
 * Receipts ScaleMargin already accepted (from the webhook) — record them as
 * reported, so the poller never forwards the same change again. Final
 * statuses end polling. Never throws: this is bookkeeping.
 */
export async function recordReportedStatuses(receipts: FreshchatReceipt[], now = new Date()): Promise<void> {
  if (!isDbInitialized() || receipts.length === 0) return;
  try {
    const rows = await findByProviderMessageIds(PROVIDER, [...new Set(receipts.map((r) => r.external_id))]);
    const byId = new Map(rows.map((r) => [r.provider_message_id, r]));
    for (const receipt of receipts) {
      const row = byId.get(receipt.external_id);
      if (!row || statusRank(receipt.event) <= statusRank(row.status_event)) continue;
      row.status_event = receipt.event;
      await updatePoll(row.id, {
        status_event: receipt.event,
        status_at: now,
        ...(isFinalEvent(receipt.event) ? { next_poll_at: null } : {}),
      });
    }
  } catch (error) {
    log.warn({ err: error instanceof Error ? error : new Error(String(error)) }, "Could not record webhook statuses for the poller");
  }
}

// ── One tick ──────────────────────────────────────────────────────────────

export type PollTickResult = { polled: number; forwarded: number; unchanged: number; errors: number; expired: boolean };

/** Per-sender pauses (429 / auth), in memory: a restart simply tries again. */
const pausedUntil = new Map<string, number>();
const warnedAuth = new Set<string>();

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    })
  );
}

const clip = (s: string) => s.slice(0, 255);

export async function pollFreshchatStatusesOnce(
  now = new Date(),
  doFetch: typeof fetch = fetch
): Promise<PollTickResult> {
  const result: PollTickResult = { polled: 0, forwarded: 0, unchanged: 0, errors: 0, expired: false };
  if (!isDbInitialized()) return result;
  const senders = pollingSenders();
  if (senders.length === 0) return result;

  await expirePolls(PROVIDER, new Date(now.getTime() - statusPollTtl().ms));
  result.expired = true;

  const active = senders.filter((s) => (pausedUntil.get(s.id) ?? 0) <= now.getTime());
  const due = await listDuePolls(PROVIDER, active.map((s) => s.id), now, BATCH_LIMIT);
  if (due.length === 0) return result;

  const bySender = new Map(active.map((s) => [s.id, s]));
  const configs = new Map(active.map((s) => [s.id, freshchatConfigFromSender(s)]));
  const changes: Array<{ row: PollRow; lookup: Extract<StatusLookup, { kind: "status" }>; event: string; next: Date | null }> = [];

  await mapLimit(due, CONCURRENCY, async (row) => {
    const sender = bySender.get(row.sender_id ?? "");
    if (!sender) return;
    // A sender paused mid-tick (429 / auth) — its remaining rows wait for the pause.
    const pause = pausedUntil.get(sender.id) ?? 0;
    if (pause > now.getTime()) {
      await updatePoll(row.id, { next_poll_at: new Date(pause) });
      return;
    }
    const cfg = configs.get(sender.id)!;
    const interval = pollIntervalMs(sender);
    const age = now.getTime() - new Date(row.sent_at).getTime();
    const scheduled = new Date(now.getTime() + nextPollDelayMs(interval, age));
    const attempts = (row.poll_attempts ?? 0) + 1;
    result.polled++;

    const lookup = cfg.apiKey
      ? await lookupStatus(cfg.apiKey, cfg.apiEndpoint, row.provider_message_id, doFetch)
      : ({ kind: "error", message: `Freshchat sender '${sender.id}' has no API key` } as StatusLookup);

    switch (lookup.kind) {
      case "status": {
        const event = mapFreshchatStatus(lookup.status);
        if (event && statusRank(event) > statusRank(row.status_event)) {
          changes.push({ row, lookup, event, next: isFinalEvent(event) ? null : scheduled });
          return;
        }
        result.unchanged++;
        await updatePoll(row.id, {
          status: lookup.status,
          ...(lookup.messageId ? { provider_ref: lookup.messageId.slice(0, 191) } : {}),
          last_polled_at: now,
          poll_attempts: attempts,
          poll_error: event ? null : clip(`unrecognised status '${lookup.status}'`),
          next_poll_at: isFinalEvent(row.status_event) ? null : scheduled,
        });
        return;
      }
      case "unknown":
        // Freshchat has no record yet (or no status) — ask again later.
        await updatePoll(row.id, { last_polled_at: now, poll_attempts: attempts, poll_error: null, next_poll_at: scheduled });
        return;
      case "rate_limited": {
        const until = now.getTime() + lookup.retryAfterMs;
        pausedUntil.set(sender.id, until);
        log.warn({ sender_id: sender.id, retry_after_ms: lookup.retryAfterMs }, `Freshchat rate-limited status polling for sender '${sender.id}' — pausing`);
        await updatePoll(row.id, { last_polled_at: now, poll_error: "rate limited (429)", next_poll_at: new Date(until) });
        return;
      }
      case "auth": {
        const until = now.getTime() + AUTH_PAUSE_MS;
        pausedUntil.set(sender.id, until);
        result.errors++;
        if (!warnedAuth.has(sender.id)) {
          warnedAuth.add(sender.id);
          log.warn(
            { sender_id: sender.id, http_status: lookup.httpStatus },
            `Freshchat status API rejected sender '${sender.id}' (${lookup.httpStatus}) — check freshchat.api_key; polling paused 5 min`
          );
        }
        await updatePoll(row.id, { last_polled_at: now, poll_error: `status API ${lookup.httpStatus}`, next_poll_at: new Date(until) });
        return;
      }
      case "error":
        result.errors++;
        await updatePoll(row.id, { last_polled_at: now, poll_attempts: attempts, poll_error: clip(lookup.message), next_poll_at: scheduled });
        return;
    }
  });

  // Forward the changes; persist each only once ScaleMargin accepted it.
  const secret = process.env.SCALEMARGIN_ANALYTICS_SECRET ?? "";
  for (let i = 0; i < changes.length; i += FORWARD_CHUNK) {
    const chunk = changes.slice(i, i + FORWARD_CHUNK);
    const receipts: FreshchatReceipt[] = chunk.map(({ row, lookup, event }) => ({
      external_id: row.provider_message_id,
      event: event as FreshchatReceipt["event"],
      // The status API reports no status time — the moment it was observed is the best there is.
      occurred_at: now.toISOString(),
      provider: PROVIDER,
      ...(event === "bounced" && lookup.cause ? { cause: lookup.cause } : {}),
      ...(event === "bounced" && lookup.errorCode ? { error_code: lookup.errorCode } : {}),
    }));
    const sent = await forwardFreshchatReceipts(receipts, secret);
    for (const { row, lookup, event, next } of chunk) {
      const base = {
        status: lookup.status,
        ...(lookup.messageId ? { provider_ref: lookup.messageId.slice(0, 191) } : {}),
        last_polled_at: now,
        poll_attempts: (row.poll_attempts ?? 0) + 1,
      };
      if (sent.success) {
        result.forwarded++;
        await updatePoll(row.id, { ...base, status_event: event, status_at: now, poll_error: null, next_poll_at: next });
      } else {
        result.errors++;
        // Not recorded as reported: the next poll sees the change again and retries.
        await updatePoll(row.id, {
          ...base,
          poll_error: clip(`forward failed: ${sent.error ?? "unknown"}`),
          next_poll_at: new Date(now.getTime() + pollIntervalMs(bySender.get(row.sender_id ?? "")!)),
        });
      }
    }
  }
  return result;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Starts only when some enabled Freshchat sender has `status_poller: true`. */
export function startFreshchatStatusPoller(): void {
  if (process.env.VITEST === "true" || timer) return;
  let senders: SenderConfig[];
  try {
    senders = pollingSenders();
  } catch (error) {
    log.warn({ err: error instanceof Error ? error : new Error(String(error)) }, "Freshchat status poller not started");
    return;
  }
  if (senders.length === 0) return;
  // Tick at the shortest interval; each message carries its own next_poll_at.
  const tickMs = Math.min(...senders.map(pollIntervalMs));
  log.info(
    {
      senders: senders.map((s) => s.id),
      tick_seconds: tickMs / 1000,
      stop_after: describeStatusPollTtl(statusPollTtl()),
    },
    `Freshchat status poller on for ${senders.length} sender(s)`
  );
  timer = setInterval(() => {
    if (running) return; // a slow tick is never overlapped
    running = true;
    void pollFreshchatStatusesOnce()
      .then((r) => {
        if (r.polled > 0) log.debug(r, "Freshchat status poll tick");
      })
      .catch((error) =>
        log.warn({ err: error instanceof Error ? error : new Error(String(error)) }, "Freshchat status poll tick failed")
      )
      .finally(() => {
        running = false;
      });
  }, tickMs);
  timer.unref();
}

export function stopFreshchatStatusPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function resetFreshchatStatusPollerForTests(): void {
  stopFreshchatStatusPoller();
  pausedUntil.clear();
  warnedAuth.clear();
  running = false;
}
