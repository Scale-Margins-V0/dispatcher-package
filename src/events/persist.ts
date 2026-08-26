/**
 * Persists StandardizedEvents into the campaign_events store that powers the
 * admin campaign console. Persistence is best-effort by design: this sits
 * inside the per-recipient send loop and the provider webhook handler, so it
 * must never throw, and it no-ops entirely when the state DB is absent.
 */

import { createHash } from "node:crypto";
import { isDbInitialized } from "../db/client.js";
import { insertCampaignEvents } from "../db/repos/campaign-events.js";
import { refreshCampaignSummarySafe } from "../db/repos/campaign-summary.js";
import { resolveProgram, type ProgramRef } from "../db/repos/dispatch-programs.js";
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
  receivedAt: Date,
  program: ProgramRef
): CampaignEventRow {
  const occurred = new Date(event.occurred_at);
  return {
    id: crypto.randomUUID(),
    campaign_id: event.campaign_id.slice(0, ID_MAX),
    program_id: program.program_id.slice(0, ID_MAX),
    program_kind: program.program_kind,
    step_id: program.step_id ? program.step_id.slice(0, ID_MAX) : null,
    organization_id: event.organization_id.slice(0, ID_MAX),
    user_id: event.user_id.slice(0, ID_MAX),
    channel: event.channel,
    event: event.event,
    provider: event.provider,
    provider_message_id: event.provider_message_id
      ? event.provider_message_id.slice(0, ID_MAX)
      : null,
    sender_id:
      typeof event.metadata?.sender_id === "string"
        ? (event.metadata.sender_id as string).slice(0, ID_MAX)
        : typeof (event as any).sender_id === "string"
          ? ((event as any).sender_id as string).slice(0, ID_MAX)
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
    // A drip send's wire id names one recipient-step; resolve it back to the
    // sequence so the console groups by program rather than by send.
    const programs = await resolveProgram(events.map((event) => event.campaign_id));
    const rows = events.map((event) =>
      campaignEventRowFromStandardized(
        event,
        now,
        programs.get(event.campaign_id) ?? {
          program_id: event.campaign_id,
          program_kind: "campaign",
          step_id: null,
        }
      )
    );
    await insertCampaignEvents(rows);

    // Refresh the durable rollup for every program this batch touched. Coalesced
    // to one recompute per program per batch — a 500-event webhook for one
    // campaign costs a single grouped query, not 500.
    for (const programId of new Set(rows.map((row) => row.program_id))) {
      refreshCampaignSummarySafe(programId);
    }
  } catch (error) {
    log.warn(
      `[Events] Could not persist ${events.length} campaign event(s) for the console: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
