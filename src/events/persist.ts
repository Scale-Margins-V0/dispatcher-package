/**
 * Persists StandardizedEvents into the campaign_events store that powers the
 * admin campaign console. Persistence is best-effort by design: this sits
 * inside the per-recipient send loop and the provider webhook handler, so it
 * must never throw, and it no-ops entirely when the state DB is absent.
 */

import { createHash } from "node:crypto";
import { isDbInitialized } from "../db/client.js";
import { insertCampaignEvents } from "../db/repos/campaign-events.js";
import type { CampaignEventRow } from "../db/schema/index.js";
import { componentLogger } from "../logging/logger.js";
import type { StandardizedEvent } from "./common/types.js";

const log = componentLogger("events");

/** MySQL indexed-varchar budget; the other dialects are unbounded text. */
const ID_MAX = 191;

/**
 * Stable unique key for insert-or-skip. Prefers the envelope's own
 * idempotency_key; falls back to a deterministic hash because
 * ensureIdempotency is delivery-mode-gated and its key omits user_id
 * (colliding for same-ms failure events with provider_message_id "unknown").
 * Deterministic across live persist and outbox backfill, so both dedupe
 * against each other.
 */
export function computeDedupeKey(event: StandardizedEvent): string {
  if (event.idempotency_key && event.idempotency_key.length <= 64) {
    return event.idempotency_key;
  }
  return createHash("sha256")
    .update(
      [
        event.campaign_id,
        event.user_id,
        event.provider,
        event.provider_message_id,
        event.event,
        event.occurred_at,
      ].join("|")
    )
    .digest("hex")
    .slice(0, 32);
}

export function campaignEventRowFromStandardized(
  event: StandardizedEvent,
  receivedAt: Date
): CampaignEventRow {
  const occurred = new Date(event.occurred_at);
  return {
    id: crypto.randomUUID(),
    campaign_id: event.campaign_id.slice(0, ID_MAX),
    organization_id: event.organization_id.slice(0, ID_MAX),
    user_id: event.user_id.slice(0, ID_MAX),
    channel: event.channel,
    event: event.event,
    provider: event.provider,
    provider_message_id: event.provider_message_id
      ? event.provider_message_id.slice(0, ID_MAX)
      : null,
    occurred_at: Number.isNaN(occurred.getTime()) ? receivedAt : occurred,
    received_at: receivedAt,
    metadata: (event.metadata as Record<string, unknown> | undefined) ?? null,
    dedupe_key: computeDedupeKey(event),
  };
}

export async function persistCampaignEvents(events: StandardizedEvent[]): Promise<void> {
  if (events.length === 0 || !isDbInitialized()) return;
  try {
    const now = new Date();
    await insertCampaignEvents(events.map((event) => campaignEventRowFromStandardized(event, now)));
  } catch (error) {
    log.warn(
      `[Events] Could not persist ${events.length} campaign event(s) for the console: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
