import { createHmac, timingSafeEqual } from "node:crypto";
import type { AnalyticsEventType } from "../../providers/types.js";
import { extractCorrelationFromGupshupEvent } from "../common/correlator.js";
import type {
  Correlation,
  InboundEventAdapter,
  SignatureRequest,
  StandardizedEvent,
} from "../common/types.js";

/**
 * Gupshup GatewayAPI delivery receipt — flat record echoing the outbound message id
 * as `externalId`, with `eventType` (DELIVERED / READ / FAILED / …), optional `cause`
 * + `errorCode`, and an epoch-millis `eventTs`. Carries no `tag`: correlation is
 * recovered downstream from the dispatch-time message-id registry, keyed by `externalId`.
 */
function normalizeGupshupGatewayReceipt(
  obj: Record<string, unknown>
): Record<string, unknown> {
  const externalId = obj.externalId as string;
  const tsRaw = obj.eventTs;
  const tsMs =
    typeof tsRaw === "number"
      ? tsRaw
      : typeof tsRaw === "string" && /^\d+$/.test(tsRaw)
        ? parseInt(tsRaw, 10)
        : NaN;
  const out: Record<string, unknown> = {
    type: "message-event",
    // Lower-cased downstream by mapGupshupStatus; keep the raw value here.
    eventType: obj.eventType,
    msgId: externalId,
    externalId,
    timestamp: new Date(Number.isFinite(tsMs) ? tsMs : Date.now()).toISOString(),
  };
  if (typeof obj.cause === "string") out.cause = obj.cause;
  if (obj.errorCode !== undefined && obj.errorCode !== null) {
    out.errorCode = String(obj.errorCode);
  }
  // destAddr is the recipient phone (PII) — map to `destination` so stripPii drops it.
  if (typeof obj.destAddr === "string") out.destination = obj.destAddr;
  return out;
}

export function normalizeGupshupInboundRecord(
  obj: Record<string, unknown>
): Record<string, unknown> {
  // GatewayAPI delivery receipt: identified by `externalId` (the echoed message id).
  // Checked before the legacy short-circuit below because these records also carry a
  // string `eventType`, but need their id and timestamp lifted into the common shape.
  if (typeof obj.externalId === "string" && typeof obj.eventType === "string") {
    return normalizeGupshupGatewayReceipt(obj);
  }
  if (typeof obj.eventType === "string" || typeof obj.msgId === "string") {
    return obj;
  }
  if (
    obj.version !== 2 ||
    obj.type !== "message-event" ||
    typeof obj.payload !== "object" ||
    obj.payload === null
  ) {
    return obj;
  }
  const p = obj.payload as Record<string, unknown>;
  const innerType = typeof p.type === "string" ? p.type : "";
  const tsOuter = obj.timestamp;
  const tsMs =
    typeof tsOuter === "number"
      ? tsOuter
      : typeof tsOuter === "string" && /^\d+$/.test(tsOuter)
        ? parseInt(tsOuter, 10)
        : NaN;
  const destination = typeof p.destination === "string" ? p.destination : undefined;
  const tag = p.tag;
  const gsId = typeof p.gsId === "string" ? p.gsId : undefined;
  const id = typeof p.id === "string" ? p.id : undefined;
  const msgId =
    innerType === "enqueued" || innerType === "failed"
      ? id && id.length > 0
        ? id
        : gsId && gsId.length > 0
          ? gsId
          : "unknown"
      : gsId && gsId.length > 0
        ? gsId
        : id && id.length > 0
          ? id
          : "unknown";

  let cause: string | undefined;
  if (innerType === "failed" && typeof p.payload === "object" && p.payload !== null) {
    const fail = p.payload as Record<string, unknown>;
    if (typeof fail.reason === "string") cause = fail.reason;
    else if (typeof fail.code === "number") cause = `code:${fail.code}`;
  }

  const out: Record<string, unknown> = {
    type: "message-event",
    eventType: innerType,
    msgId,
    timestamp: new Date(Number.isFinite(tsMs) ? tsMs : Date.now()).toISOString(),
    destination,
    tag,
  };
  if (cause) out.cause = cause;
  return out;
}

function headerOne(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      if (Array.isArray(v)) return v[0];
      return typeof v === "string" ? v : undefined;
    }
  }
  return undefined;
}

function stripGupshup(obj: Record<string, unknown>): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
  delete out.destination;
  delete out.mobile;
  delete out.sender;
  if (out.payload && typeof out.payload === "object") {
    const p = out.payload as Record<string, unknown>;
    delete p.source;
    delete p.destination;
  }
  return out;
}

/**
 * WhatsApp (Gupshup) delivery status → canonical analytics event, so WhatsApp logs
 * the same lowercase vocabulary as email:
 *   ENQUEUED / SENT → dispatched
 *   DELIVERED       → delivered
 *   READ            → opened     (a WhatsApp read == an email open)
 *   CLICKED         → clicked    (WhatsApp button/link clicks, when enabled)
 *   FAILED          → failed     (the backend canonicalizes failed → bounced)
 * Returns null for statuses with no analytics mapping (dropped + logged upstream).
 */
function mapGupshupStatus(status: string): AnalyticsEventType | null {
  const m: Record<string, AnalyticsEventType> = {
    enqueued: "dispatched",
    sent: "dispatched",
    delivered: "delivered",
    read: "opened",
    clicked: "clicked",
    failed: "failed",
  };
  return m[status.toLowerCase()] ?? null;
}

/**
 * A correlation-free WhatsApp delivery receipt forwarded to the backend, which
 * matches `external_id` against the dispatched event's `metadata.provider_message_id`.
 */
export interface GupshupReceipt {
  external_id: string;
  event: AnalyticsEventType;
  occurred_at: string;
  cause?: string;
  error_code?: string;
}

/**
 * Build a forwardable receipt from a normalized GatewayAPI delivery record
 * (externalId + eventType, no tag). Returns null for records that are not
 * recognizable receipts or whose status has no analytics mapping.
 */
export function extractGupshupReceipt(item: unknown): GupshupReceipt | null {
  if (!item || typeof item !== "object") return null;
  const e = item as Record<string, unknown>;
  const external_id =
    typeof e.externalId === "string"
      ? e.externalId
      : typeof e.msgId === "string"
        ? e.msgId
        : undefined;
  if (!external_id) return null;
  const statusRaw =
    typeof e.eventType === "string"
      ? e.eventType
      : typeof e.status === "string"
        ? e.status
        : "";
  const event = mapGupshupStatus(statusRaw);
  if (!event) return null;
  const occurred_at =
    typeof e.timestamp === "string"
      ? new Date(e.timestamp).toISOString()
      : new Date().toISOString();
  const cause = typeof e.cause === "string" ? e.cause : undefined;
  const error_code = typeof e.errorCode === "string" ? e.errorCode : undefined;
  return {
    external_id,
    event,
    occurred_at,
    ...(cause ? { cause } : {}),
    ...(error_code ? { error_code } : {}),
  };
}

export function createGupshupInboundAdapter(webhookSecret: string): InboundEventAdapter {
  return {
    name: "gupshup",
    channel: "whatsapp",
    verifySignature(req: SignatureRequest): boolean {
      // No secret configured → open webhook: skip signature verification.
      if (!webhookSecret) return true;
      const sig = headerOne(req.headers, "x-gupshup-signature");
      if (!sig) return false;
      const expected = createHmac("sha256", webhookSecret).update(req.rawBody).digest("hex");
      try {
        const a = Buffer.from(sig, "utf-8");
        const b = Buffer.from(expected, "utf-8");
        if (a.length !== b.length) return false;
        return timingSafeEqual(a, b);
      } catch {
        return false;
      }
    },
    parseEvents(rawBody: Buffer): unknown[] {
      const parsed = JSON.parse(rawBody.toString("utf-8")) as unknown;
      // GatewayAPI delivery receipts arrive as a JSON array of records; the legacy
      // tag-echo webhook is a single object. Normalize both to a flat record list.
      const records = Array.isArray(parsed) ? parsed : [parsed];
      return records.map((r) =>
        normalizeGupshupInboundRecord(r as Record<string, unknown>)
      );
    },
    extractCorrelation(event: unknown): Correlation | null {
      // Tag-echo path (io/enterprise sends embed campaign metadata in `tag`).
      // GatewayAPI delivery receipts carry no tag — they correlate later on the
      // backend by externalId (see extractGupshupReceipt + the inbound handler).
      return extractCorrelationFromGupshupEvent(event);
    },
    stripPii(event: unknown): Record<string, unknown> {
      if (!event || typeof event !== "object") return {};
      return stripGupshup(event as Record<string, unknown>);
    },
    toStandardEvent(stripped: Record<string, unknown>, c: Correlation): StandardizedEvent | null {
      const statusRaw =
        typeof stripped.eventType === "string"
          ? stripped.eventType
          : typeof stripped.status === "string"
            ? stripped.status
            : "";
      const mapped = mapGupshupStatus(statusRaw);
      if (!mapped) return null;
      const provider_message_id =
        typeof stripped.msgId === "string" ? stripped.msgId : "unknown";
      const occurred_at =
        typeof stripped.timestamp === "string"
          ? new Date(stripped.timestamp).toISOString()
          : new Date().toISOString();
      const metadata: StandardizedEvent["metadata"] = {};
      if (typeof stripped.cause === "string") metadata.bounce_reason = stripped.cause;
      if (typeof stripped.errorCode === "string") metadata.error_code = stripped.errorCode;
      return {
        ...c,
        channel: "whatsapp",
        event: mapped,
        provider: "gupshup",
        provider_message_id,
        occurred_at,
        metadata: Object.keys(metadata).length ? metadata : undefined,
      };
    },
  };
}
