import { createHmac, timingSafeEqual } from "node:crypto";
import type { AnalyticsEventType } from "../../providers/types.js";
import { extractCorrelationFromGupshupEvent } from "../common/correlator.js";
import { SMSIGN_PREFIX } from "../tag-sign.js";
import type {
  Correlation,
  InboundEventAdapter,
  SignatureRequest,
  StandardizedEvent,
} from "../common/types.js";

/**
 * Freshchat WhatsApp delivery / status receipt.
 */
export interface FreshchatReceipt {
  external_id: string;
  event: AnalyticsEventType;
  occurred_at: string;
  cause?: string;
  error_code?: string;
  sign?: string;
  provider?: string;
}

export function mapFreshchatStatus(status: string): AnalyticsEventType | null {
  const norm = status.trim().toUpperCase();
  switch (norm) {
    case "ACCEPTED":
    case "SUBMITTED":
    case "QUEUED":
    case "ENQUEUED":
    case "SENT":
      return "dispatched";
    case "DELIVERED":
      return "delivered";
    case "READ":
    case "SEEN":
      return "read";
    case "FAILED":
    case "UNDELIVERED":
    case "REJECTED":
      return "bounced";
    case "CLICKED":
      return "clicked";
    default:
      return null;
  }
}

/**
 * Normalizes wrapped or flat Freshchat outbound message webhook payloads.
 */
export function normalizeFreshchatInboundRecord(
  obj: Record<string, unknown>
): Record<string, unknown> {
  if (
    obj.event_type === "outbound_message_event" &&
    typeof obj.data === "object" &&
    obj.data !== null
  ) {
    const d = obj.data as Record<string, unknown>;
    const eventTime = obj.event_time;
    const tsMs =
      typeof eventTime === "number"
        ? eventTime
        : typeof eventTime === "string" && /^\d+$/.test(eventTime)
          ? parseInt(eventTime, 10)
          : NaN;

    const timestamp = Number.isFinite(tsMs)
      ? new Date(tsMs).toISOString()
      : typeof d.timestamp === "string"
        ? d.timestamp
        : new Date().toISOString();

    const externalId =
      (typeof d.request_id === "string" && d.request_id) ||
      (typeof d.message_id === "string" && d.message_id) ||
      (typeof d.external_id === "string" && d.external_id) ||
      (typeof d.externalId === "string" && d.externalId) ||
      (typeof d.id === "string" && d.id) ||
      undefined;

    const out: Record<string, unknown> = {
      ...d,
      externalId,
      request_id: d.request_id ?? externalId,
      message_id: d.message_id ?? externalId,
      eventType: d.status ?? d.eventType ?? d.type,
      status: d.status ?? d.eventType ?? d.type,
      timestamp,
      account_id: obj.account_id,
    };

    if (typeof d.failure_reason === "string") out.cause = d.failure_reason;
    if (d.failure_code !== undefined && d.failure_code !== null) {
      out.errorCode = String(d.failure_code);
    }
    return out;
  }

  const externalId =
    (typeof obj.request_id === "string" && obj.request_id) ||
    (typeof obj.message_id === "string" && obj.message_id) ||
    (typeof obj.external_id === "string" && obj.external_id) ||
    (typeof obj.externalId === "string" && obj.externalId) ||
    (typeof obj.id === "string" && obj.id) ||
    undefined;

  const status =
    (typeof obj.status === "string" && obj.status) ||
    (typeof obj.eventType === "string" && obj.eventType) ||
    (typeof obj.type === "string" && obj.type) ||
    "";

  return {
    ...obj,
    externalId,
    request_id: obj.request_id ?? externalId,
    message_id: obj.message_id ?? externalId,
    status,
    eventType: status,
    timestamp:
      typeof obj.timestamp === "string"
        ? obj.timestamp
        : typeof obj.created_on === "string"
          ? obj.created_on
          : new Date().toISOString(),
  };
}

export function extractFreshchatReceipt(item: unknown): FreshchatReceipt | null {
  if (!item || typeof item !== "object") return null;
  const normalized = normalizeFreshchatInboundRecord(item as Record<string, unknown>);

  const external_id =
    typeof normalized.externalId === "string" && normalized.externalId
      ? normalized.externalId
      : typeof normalized.request_id === "string" && normalized.request_id
        ? normalized.request_id
        : typeof normalized.message_id === "string" && normalized.message_id
          ? normalized.message_id
          : undefined;

  if (!external_id) return null;

  const statusRaw =
    typeof normalized.status === "string"
      ? normalized.status
      : typeof normalized.eventType === "string"
        ? normalized.eventType
        : "";

  const event = mapFreshchatStatus(statusRaw);
  if (!event) return null;

  const occurred_at =
    typeof normalized.timestamp === "string"
      ? new Date(normalized.timestamp).toISOString()
      : new Date().toISOString();

  const cause =
    typeof normalized.cause === "string"
      ? normalized.cause
      : typeof normalized.failure_reason === "string"
        ? normalized.failure_reason
        : undefined;

  const error_code =
    normalized.errorCode !== undefined && normalized.errorCode !== null
      ? String(normalized.errorCode)
      : normalized.failure_code !== undefined && normalized.failure_code !== null
        ? String(normalized.failure_code)
        : undefined;

  const sign =
    typeof normalized.extra === "string" && normalized.extra.startsWith(SMSIGN_PREFIX)
      ? normalized.extra.slice(SMSIGN_PREFIX.length)
      : undefined;

  return {
    external_id,
    event,
    occurred_at,
    provider: "freshchat",
    ...(cause ? { cause } : {}),
    ...(error_code ? { error_code } : {}),
    ...(sign ? { sign } : {}),
  };
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

const PII_KEYS = new Set([
  "phone",
  "phone_number",
  "to",
  "from",
  "destination",
  "destaddr",
  "contact_number",
  "recipient",
]);

function deepCloneDeleteKeys(
  obj: Record<string, unknown>,
  keys: Set<string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (keys.has(k.toLowerCase())) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepCloneDeleteKeys(v as Record<string, unknown>, keys);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function safeCompareTokens(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

export function createFreshchatInboundAdapter(secret?: string): InboundEventAdapter {
  const trimmedSecret = secret?.trim() || "";

  return {
    name: "freshchat",
    channel: "whatsapp",

    verifySignature(req: SignatureRequest): boolean {
      if (!trimmedSecret) {
        return true;
      }

      // Check Bearer / custom Authorization header first
      const authHeader = headerOne(req.headers, "authorization");
      if (authHeader) {
        const token = authHeader.startsWith("Bearer ")
          ? authHeader.slice(7).trim()
          : authHeader.trim();
        if (safeCompareTokens(token, trimmedSecret)) return true;
      }

      // Check X-Freshchat-Signature or X-Webhook-Secret / X-ScaleMargin-Signature
      const sigHeader =
        headerOne(req.headers, "x-freshchat-signature") ||
        headerOne(req.headers, "x-webhook-secret") ||
        headerOne(req.headers, "x-scalemargin-signature");

      if (!sigHeader) return false;

      const rawSig = sigHeader.startsWith("sha256=")
        ? sigHeader.slice(7).trim()
        : sigHeader.trim();

      try {
        const computed = createHmac("sha256", trimmedSecret)
          .update(req.rawBody)
          .digest("hex");
        const a = Buffer.from(computed.toLowerCase(), "hex");
        const b = Buffer.from(rawSig.toLowerCase(), "hex");
        return a.length === b.length && timingSafeEqual(a, b);
      } catch {
        return false;
      }
    },

    parseEvents(rawBody: Buffer): unknown[] {
      const text = rawBody.toString("utf-8").trim();
      if (!text) return [];
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object") return [parsed];
      return [];
    },

    extractCorrelation(event: unknown): Correlation | null {
      if (!event || typeof event !== "object") return null;
      const normalized = normalizeFreshchatInboundRecord(event as Record<string, unknown>);
      return extractCorrelationFromGupshupEvent(normalized);
    },

    stripPii(event: unknown): Record<string, unknown> {
      if (!event || typeof event !== "object") return {};
      const normalized = normalizeFreshchatInboundRecord(event as Record<string, unknown>);
      return deepCloneDeleteKeys(normalized, PII_KEYS);
    },

    toStandardEvent(
      stripped: Record<string, unknown>,
      c: Correlation
    ): StandardizedEvent | null {
      const statusRaw =
        typeof stripped.status === "string"
          ? stripped.status
          : typeof stripped.eventType === "string"
            ? stripped.eventType
            : "";

      const event = mapFreshchatStatus(statusRaw);
      if (!event) return null;

      const occurred_at =
        typeof stripped.timestamp === "string"
          ? new Date(stripped.timestamp).toISOString()
          : new Date().toISOString();

      const providerMessageId =
        (typeof stripped.externalId === "string" && stripped.externalId) ||
        (typeof stripped.request_id === "string" && stripped.request_id) ||
        (typeof stripped.message_id === "string" && stripped.message_id) ||
        "unknown";

      const metadata: StandardizedEvent["metadata"] = {};
      if (typeof stripped.cause === "string") {
        metadata.bounce_reason = stripped.cause;
      }
      if (stripped.errorCode !== undefined && stripped.errorCode !== null) {
        metadata.error_code = String(stripped.errorCode);
      }

      return {
        campaign_id: c.campaign_id,
        user_id: c.user_id,
        organization_id: c.organization_id,
        ...(c.analytics_callback_url ? { analytics_callback_url: c.analytics_callback_url } : {}),
        channel: "whatsapp",
        event,
        provider: "freshchat",
        provider_message_id: providerMessageId,
        occurred_at,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      };
    },
  };
}
