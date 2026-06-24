import { createHmac, timingSafeEqual } from "node:crypto";
import type { AnalyticsEventType } from "../../providers/types.js";
import { extractCorrelationFromGupshupEvent } from "../common/correlator.js";
import type {
  Correlation,
  InboundEventAdapter,
  SignatureRequest,
  StandardizedEvent,
} from "../common/types.js";

export function normalizeGupshupInboundRecord(
  obj: Record<string, unknown>
): Record<string, unknown> {
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

function mapGupshupStatus(status: string): AnalyticsEventType | null {
  const m: Record<string, AnalyticsEventType> = {
    enqueued: "dispatched",
    sent: "sent",
    delivered: "delivered",
    read: "read",
    failed: "failed",
  };
  return m[status.toLowerCase()] ?? null;
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
      const body = JSON.parse(rawBody.toString("utf-8")) as Record<string, unknown>;
      return [normalizeGupshupInboundRecord(body)];
    },
    extractCorrelation(event: unknown): Correlation | null {
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
