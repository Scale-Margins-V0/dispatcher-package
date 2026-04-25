/**
 * HMAC-signed POST of standardized events to ScaleMargin analytics webhooks.
 */

import { createHash, createHmac } from "node:crypto";
import type { AnalyticsEvent, AnalyticsPayload } from "../providers/types.js";
import type { StandardizedEvent } from "./common/types.js";

const MAX_RETRIES = 3;

export function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function buildIdempotencyKey(
  provider: string,
  providerMessageId: string,
  event: string,
  occurredAt: string
): string {
  return createHash("sha256")
    .update(`${provider}|${providerMessageId}|${event}|${occurredAt}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Validate that the callback URL points to a trusted ScaleMargin endpoint.
 * Prevents SSRF via malicious analytics_callback_url in dispatch payload.
 */
export function validateCallbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    const isDockerHost = hostname === "host.docker.internal";

    if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:" && !isDockerHost) {
      return false;
    }

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }

    const isPrivate =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("172.");

    if (isPrivate && !isDockerHost) {
      if (process.env.NODE_ENV === "production") return false;
    }

    if (!parsed.pathname.includes("/api/webhooks/campaign-analytics")) {
      if (process.env.NODE_ENV === "production") {
        return false;
      }
      console.warn(
        `[EventsForwarder] Unexpected callback path: ${parsed.pathname}. Proceeding anyway.`
      );
    }

    return true;
  } catch {
    return false;
  }
}

export function standardizedToAnalyticsEvent(e: StandardizedEvent): AnalyticsEvent {
  return {
    user_id: e.user_id,
    event: e.event,
    timestamp: e.occurred_at,
    channel: e.channel,
    ...(e.idempotency_key && { idempotency_key: e.idempotency_key }),
    metadata: {
      ...(e.metadata ?? {}),
      /**
       * Duplicated from top-level / batch envelope so each event row is self-contained
       * (CSV `metadata_json`, single-blob downstream parsers) — same shape for SES and SendGrid.
       */
      user_id: e.user_id,
      campaign_id: e.campaign_id,
      organization_id: e.organization_id,
      channel: e.channel,
      provider: e.provider,
      provider_message_id: e.provider_message_id,
      ...(e.analytics_callback_url && { analytics_callback_url: e.analytics_callback_url }),
    },
  };
}

function groupKey(callbackUrl: string, campaignId: string, orgId: string): string {
  return `${callbackUrl}\u0000${campaignId}\u0000${orgId}`;
}

export function groupEnvelopesByDestination(
  envelopes: Array<{ callbackUrl: string; event: StandardizedEvent }>
): Map<
  string,
  { callbackUrl: string; campaign_id: string; organization_id: string; events: StandardizedEvent[] }
> {
  const m = new Map<
    string,
    { callbackUrl: string; campaign_id: string; organization_id: string; events: StandardizedEvent[] }
  >();
  for (const env of envelopes) {
    const k = groupKey(env.callbackUrl, env.event.campaign_id, env.event.organization_id);
    let g = m.get(k);
    if (!g) {
      g = {
        callbackUrl: env.callbackUrl,
        campaign_id: env.event.campaign_id,
        organization_id: env.event.organization_id,
        events: [],
      };
      m.set(k, g);
    }
    g.events.push(env.event);
  }
  return m;
}

export function buildPayloadForGroup(params: {
  campaign_id: string;
  organization_id: string;
  events: StandardizedEvent[];
}): AnalyticsPayload {
  return {
    campaign_id: params.campaign_id,
    organization_id: params.organization_id,
    events: params.events.map((e) => standardizedToAnalyticsEvent(e)),
  };
}

export async function postAnalyticsWithRetry(
  callbackUrl: string,
  payload: AnalyticsPayload,
  secret: string
): Promise<{ success: boolean; error?: string }> {
  if (!secret) {
    return { success: false, error: "Analytics secret not configured" };
  }
  if (!validateCallbackUrl(callbackUrl)) {
    return { success: false, error: "Invalid callback URL" };
  }

  const body = JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  const signature = signPayload(body, secret);

  let lastError: string | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(callbackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ScaleMargin-Signature": `sha256=${signature}`,
          "X-ScaleMargin-Timestamp": timestamp,
        },
        body,
      });

      if (response.ok) {
        return { success: true };
      }

      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        const errorText = await response.text();
        return { success: false, error: `${response.status}: ${errorText}` };
      }

      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown error";
    }

    if (attempt < MAX_RETRIES) {
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  return { success: false, error: lastError };
}

/**
 * Flush a batch of envelopes: groups by callback + campaign, POSTs each group.
 */
export async function flushEnvelopesSync(
  envelopes: Array<{ callbackUrl: string; event: StandardizedEvent }>,
  secret: string
): Promise<{ ok: boolean; errors: string[] }> {
  const groups = groupEnvelopesByDestination(envelopes);
  const errors: string[] = [];
  for (const g of groups.values()) {
    const payload = buildPayloadForGroup({
      campaign_id: g.campaign_id,
      organization_id: g.organization_id,
      events: g.events,
    });
    const r = await postAnalyticsWithRetry(g.callbackUrl, payload, secret);
    if (!r.success && r.error) errors.push(r.error);
  }
  return { ok: errors.length === 0, errors };
}
