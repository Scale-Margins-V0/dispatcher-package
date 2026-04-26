/**
 * Which SendGrid webhook `event` wire values we forward to ScaleMargin.
 */

import { mapSendGridEventType } from "./adapter.js";

export const DEFAULT_SENDGRID_INBOUND_WIRE_EVENTS = [
  "processed",
  "delivered",
  "bounce",
  "dropped",
  "deferred",
  "spamreport",
  "unsubscribe",
  "group_unsubscribe",
] as const;

function readWire(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const e = (item as Record<string, unknown>).event;
  return typeof e === "string" ? e : "";
}

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
