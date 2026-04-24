/**
 * Placeholder for production “preference” handling (suppression lists, CRM, etc.).
 * Logs a PII-safe summary after correlation + adapter stripPii + metadata scrubber.
 * Disable with EVENT_PREFERENCE_SIMULATION_LOG=0.
 */

import type { StandardizedEvent } from "./types.js";

/** Types that typically trigger downstream user-preference updates. */
const SIDE_EFFECT_TYPES = new Set<StandardizedEvent["event"]>(["unsubscribed", "complained"]);

/**
 * Structured log line your real system can replace with an internal webhook or queue consumer.
 */
export function logPreferenceSideEffectSimulation(event: StandardizedEvent): void {
  if (process.env.EVENT_PREFERENCE_SIMULATION_LOG === "0" || !SIDE_EFFECT_TYPES.has(event.event)) return;
  const line = {
    kind: "preference_side_effect_simulation",
    hint: "Wire this to suppression / CRM in production; analytics POST already carries the same event.",
    event: event.event,
    campaign_id: event.campaign_id,
    user_id: event.user_id,
    organization_id: event.organization_id,
    channel: event.channel,
    provider: event.provider,
    provider_message_id: event.provider_message_id,
    occurred_at: event.occurred_at,
    ...(event.idempotency_key ? { idempotency_key: event.idempotency_key } : {}),
    ...(event.metadata && Object.keys(event.metadata).length > 0 ? { metadata: event.metadata } : {}),
  };
  console.log(`[Events][PreferenceSimulation] ${JSON.stringify(line)}`);
}
