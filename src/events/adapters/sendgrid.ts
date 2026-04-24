import { EventWebhook, EventWebhookHeader } from "@sendgrid/eventwebhook";
import type { AnalyticsEventType } from "../../providers/types.js";
import { extractCorrelationFromSendGridEvent } from "../correlator.js";
import type { Correlation, InboundEventAdapter, SignatureRequest, StandardizedEvent } from "../types.js";

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

function deepCloneDeleteKeys(obj: Record<string, unknown>, keys: Set<string>): Record<string, unknown> {
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

const PII_KEYS = new Set([
  "email",
  "ip",
  "useragent",
  "user_agent",
  "from",
  "tls",
  "smtp-id",
]);

/** Maps SendGrid Event Webhook `event` wire value → analytics type; extend when adding new captures. */
export function mapSendGridEventType(sg: string): AnalyticsEventType | null {
  const m: Record<string, AnalyticsEventType> = {
    processed: "dispatched",
    deferred: "deferred",
    delivered: "delivered",
    open: "opened",
    click: "clicked",
    bounce: "bounced",
    dropped: "bounced",
    spamreport: "complained",
    unsubscribe: "unsubscribed",
    group_unsubscribe: "unsubscribed",
  };
  return m[sg] ?? null;
}

function sgTimestampToIso(ts: unknown): string {
  if (typeof ts === "number") {
    return new Date(ts * 1000).toISOString();
  }
  if (typeof ts === "string") {
    const n = Number(ts);
    if (!Number.isNaN(n) && n < 1e12) return new Date(n * 1000).toISOString();
    return new Date(ts).toISOString();
  }
  return new Date().toISOString();
}

export function createSendGridInboundAdapter(publicKeyBase64: string): InboundEventAdapter {
  const ew = new EventWebhook();
  const pubKey = ew.convertPublicKeyToECDSA(publicKeyBase64);

  return {
    name: "sendgrid",
    channel: "email",

    verifySignature(req: SignatureRequest): boolean {
      try {
        const sig =
          headerOne(req.headers, EventWebhookHeader.SIGNATURE()) ??
          headerOne(req.headers, "X-Twilio-Email-Event-Webhook-Signature");
        const ts =
          headerOne(req.headers, EventWebhookHeader.TIMESTAMP()) ??
          headerOne(req.headers, "X-Twilio-Email-Event-Webhook-Timestamp");
        if (!sig || !ts) return false;
        const payload = req.rawBody;
        return ew.verifySignature(pubKey, payload, sig, ts);
      } catch {
        return false;
      }
    },

    parseEvents(rawBody: Buffer): unknown[] {
      const text = rawBody.toString("utf-8").trimEnd();
      const parsed = JSON.parse(text) as unknown;
      return Array.isArray(parsed) ? parsed : [parsed];
    },

    extractCorrelation(event: unknown): Correlation | null {
      return extractCorrelationFromSendGridEvent(event);
    },

    stripPii(event: unknown): Record<string, unknown> {
      if (!event || typeof event !== "object") return {};
      return deepCloneDeleteKeys(event as Record<string, unknown>, PII_KEYS);
    },

    toStandardEvent(stripped: Record<string, unknown>, c: Correlation): StandardizedEvent | null {
      const sgEvent = typeof stripped.event === "string" ? stripped.event : "";
      const mapped = mapSendGridEventType(sgEvent);
      if (!mapped) return null;
      const provider_message_id =
        (typeof stripped.sg_message_id === "string" && stripped.sg_message_id) ||
        (typeof stripped["smtp-id"] === "string" && stripped["smtp-id"]) ||
        "unknown";
      const occurred_at = sgTimestampToIso(stripped.timestamp);
      const metadata: StandardizedEvent["metadata"] = {};
      if (typeof stripped.sg_event_id === "string") {
        metadata.provider_event_id = stripped.sg_event_id;
      }
      if (sgEvent === "bounce" || sgEvent === "dropped") {
        if (typeof stripped.type === "string") {
          const t = stripped.type.toLowerCase();
          if (t === "blocked" || t === "bounce") metadata.bounce_type = "hard";
          else metadata.bounce_type = "soft";
        } else {
          metadata.bounce_type = sgEvent === "dropped" ? "block" : "hard";
        }
        if (typeof stripped.reason === "string") metadata.bounce_reason = stripped.reason;
      }
      if (sgEvent === "click" && typeof stripped.url === "string") {
        metadata.click_url = stripped.url;
      }
      if (sgEvent === "unsubscribe") {
        metadata.unsubscribe_source = "global";
      }
      if (sgEvent === "group_unsubscribe") {
        metadata.unsubscribe_source = "asm";
        const gid = stripped.asm_group_id;
        if (typeof gid === "number") metadata.asm_group_id = gid;
        else if (typeof gid === "string" && gid.trim() !== "" && !Number.isNaN(Number(gid))) {
          metadata.asm_group_id = Number(gid);
        }
      }
      return {
        ...c,
        channel: "email",
        event: mapped,
        provider: "sendgrid",
        provider_message_id,
        occurred_at,
        metadata: Object.keys(metadata).length ? metadata : undefined,
      };
    },
  };
}
