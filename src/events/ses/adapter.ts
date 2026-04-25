import type { AnalyticsEventType } from "../../providers/types.js";
import { getCampaignCallback } from "../campaign-callback-registry.js";
import { extractCorrelationFromSesMail } from "../common/correlator.js";
import type {
  Correlation,
  InboundEventAdapter,
  SignatureRequest,
  StandardizedEvent,
} from "../common/types.js";
import { verifySnsMessage } from "../sns-verify.js";

function clone(obj: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
}

function stripSesInner(inner: Record<string, unknown>): Record<string, unknown> {
  const out = clone(inner) as Record<string, unknown>;
  const mail = out.mail as Record<string, unknown> | undefined;
  if (mail) {
    delete mail.destination;
    delete mail.source;
    delete mail.commonHeaders;
    if (Array.isArray(mail.headers)) mail.headers = [];
  }
  const bounce = out.bounce as Record<string, unknown> | undefined;
  if (bounce) delete bounce.bouncedRecipients;
  const complaint = out.complaint as Record<string, unknown> | undefined;
  if (complaint) delete complaint.complainedRecipients;
  const delivery = out.delivery as Record<string, unknown> | undefined;
  if (delivery) delete delivery.recipients;
  const open = out.open as Record<string, unknown> | undefined;
  if (open) {
    delete open.ipAddress;
    delete open.userAgent;
  }
  const click = out.click as Record<string, unknown> | undefined;
  if (click) {
    delete click.ipAddress;
    delete click.userAgent;
  }
  if ("subscription" in out) delete out.subscription;
  return out;
}

function mapSesEventType(eventType: string): AnalyticsEventType | null {
  const m: Record<string, AnalyticsEventType> = {
    Bounce: "bounced",
    Complaint: "complained",
    Delivery: "delivered",
    Open: "opened",
    Click: "clicked",
    Reject: "bounced",
    Send: "dispatched",
    Subscription: "unsubscribed",
  };
  return m[eventType] ?? null;
}

export type SesVerifyFn = (body: Record<string, unknown>) => Promise<boolean>;

export function createSesInboundAdapter(opts?: { verify?: SesVerifyFn }): InboundEventAdapter {
  const verifyFn = opts?.verify ?? ((body: Record<string, unknown>) => verifySnsMessage(body));

  return {
    name: "ses",
    channel: "email",
    async verifySignature(req: SignatureRequest): Promise<boolean> {
      let outer: Record<string, unknown>;
      try {
        outer = JSON.parse(req.rawBody.toString("utf-8")) as Record<string, unknown>;
      } catch {
        return false;
      }
      return verifyFn(outer);
    },
    parseEvents(rawBody: Buffer): unknown[] {
      const outer = JSON.parse(rawBody.toString("utf-8")) as Record<string, unknown>;
      if (outer.Type !== "Notification" || typeof outer.Message !== "string") {
        return [];
      }
      try {
        const inner = JSON.parse(String(outer.Message).trimEnd()) as unknown;
        return [inner];
      } catch {
        return [];
      }
    },
    extractCorrelation(event: unknown): Correlation | null {
      if (!event || typeof event !== "object") return null;
      const inner = event as Record<string, unknown>;
      const c = extractCorrelationFromSesMail(inner.mail);
      if (!c) return null;
      const reg = getCampaignCallback(c.campaign_id);
      return {
        ...c,
        ...(reg?.analytics_callback_url && { analytics_callback_url: reg.analytics_callback_url }),
      };
    },
    stripPii(event: unknown): Record<string, unknown> {
      if (!event || typeof event !== "object") return {};
      return stripSesInner(event as Record<string, unknown>);
    },
    toStandardEvent(stripped: Record<string, unknown>, c: Correlation): StandardizedEvent | null {
      const eventType =
        typeof stripped.eventType === "string"
          ? stripped.eventType
          : typeof stripped.notificationType === "string"
            ? stripped.notificationType
            : "";
      const mapped = mapSesEventType(eventType);
      if (!mapped) return null;
      const mail = stripped.mail as Record<string, unknown> | undefined;
      const provider_message_id =
        (mail && typeof mail.messageId === "string" && mail.messageId) || "unknown";
      const mailTs = mail && typeof mail.timestamp === "string" ? mail.timestamp : undefined;
      const occurred_at =
        mailTs ??
        (typeof (stripped.bounce as Record<string, unknown>)?.timestamp === "string"
          ? ((stripped.bounce as Record<string, unknown>).timestamp as string)
          : new Date().toISOString());

      const metadata: StandardizedEvent["metadata"] = {};
      metadata.provider_event_id = provider_message_id;
      if (eventType === "Reject") {
        metadata.bounce_type = "block";
        const rej = stripped.reject as Record<string, unknown> | undefined;
        if (rej && typeof rej.reason === "string") metadata.bounce_reason = rej.reason;
      }
      if (eventType === "Bounce") {
        const bounce = stripped.bounce as Record<string, unknown> | undefined;
        const bt = bounce && typeof bounce.bounceType === "string" ? bounce.bounceType : "";
        metadata.bounce_type = bt === "Transient" ? "soft" : "hard";
      }
      if (eventType === "Click") {
        const click = stripped.click as Record<string, unknown> | undefined;
        if (click && typeof click.link === "string") metadata.click_url = click.link;
      }
      if (eventType === "Subscription") {
        metadata.unsubscribe_source = "ses_subscription";
      }
      return {
        ...c,
        channel: "email",
        event: mapped,
        provider: "ses",
        provider_message_id,
        occurred_at,
        metadata,
      };
    },
  };
}
