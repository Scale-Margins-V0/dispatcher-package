/**
 * Which SendGrid webhook `event` wire values we forward to ScaleMargin.
 * When SendGrid Event Webhook is not configured, nothing arrives here — dispatch still emits `dispatched`.
 * When it is configured, a **default minimal set** avoids noise (opens/clicks) unless you opt in via YAML or env.
 */

import { mapSendGridEventType } from "./adapters/sendgrid.js";

/** Lifecycle + deliverability + abuse — no open/click/unsubscribe by default. */
export const DEFAULT_SENDGRID_INBOUND_WIRE_EVENTS = [
  "processed",
  "delivered",
  "bounce",
  "dropped",
  "deferred",
  "spamreport",
] as const;

function readWire(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const e = (item as Record<string, unknown>).event;
  return typeof e === "string" ? e : "";
}

/**
 * @param inbound_event_types — from config `providers.sendgrid.inbound_event_types`:
 *   - `undefined` or `[]`: use {@link DEFAULT_SENDGRID_INBOUND_WIRE_EVENTS}
 *   - `["*"]`: any wire value we can map to an `AnalyticsEventType`
 *   - explicit list: only those wires (must match SendGrid payload `event` field)
 */
export function sendGridInboundWireAllowed(
  item: unknown,
  inbound_event_types: string[] | undefined
): boolean {
  const wire = readWire(item);
  if (!wire) return false;

  const list = inbound_event_types;
  if (!list || list.length === 0) {
    return (DEFAULT_SENDGRID_INBOUND_WIRE_EVENTS as readonly string[]).includes(wire);
  }
  if (list.length === 1 && list[0] === "*") {
    return mapSendGridEventType(wire) !== null;
  }
  return list.includes(wire);
}
