/**
 * Analytics Reporter
 *
 * Reports delivery analytics back to ScaleMargin's inbound webhook.
 * Supports both real-time (per-event) and batch (post-campaign) reporting.
 *
 * Sign the payload with HMAC-SHA256 using the shared analytics secret.
 */

import { createHmac } from "node:crypto";
import type { AnalyticsPayload, AnalyticsEvent, AnalyticsSummary } from "./providers/types.js";

const ANALYTICS_SECRET = process.env.SCALEMARGIN_ANALYTICS_SECRET || "";

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Report analytics to ScaleMargin.
 *
 * @param callbackUrl - ScaleMargin analytics webhook URL
 *   (from metadata.analytics_callback_url in the dispatch payload)
 * @param payload - Analytics data (events and/or summary)
 */
export async function reportAnalytics(
  callbackUrl: string,
  payload: AnalyticsPayload
): Promise<{ success: boolean; error?: string }> {
  const secret = ANALYTICS_SECRET;
  if (!secret) {
    console.error("[Analytics] SCALEMARGIN_ANALYTICS_SECRET not configured");
    return { success: false, error: "Analytics secret not configured" };
  }

  const body = JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  const signature = signPayload(body, secret);

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
      const result = await response.json();
      console.log(
        `[Analytics] Reported to ScaleMargin: ${result.events_processed} events processed`
      );
      return { success: true };
    }

    const errorText = await response.text();
    console.error(
      `[Analytics] ScaleMargin rejected analytics: ${response.status} ${errorText}`
    );
    return { success: false, error: `${response.status}: ${errorText}` };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[Analytics] Failed to report: ${msg}`);
    return { success: false, error: msg };
  }
}

/**
 * Build a batch analytics payload from send results.
 *
 * Call this after sending a campaign to report delivery results
 * back to ScaleMargin in a single batch.
 */
export function buildBatchPayload(params: {
  campaignId: string;
  organizationId: string;
  results: Array<{
    userId: string;
    success: boolean;
    messageId?: string;
    error?: string;
  }>;
}): AnalyticsPayload {
  const now = new Date().toISOString();

  const events: AnalyticsEvent[] = params.results.map((r) => ({
    user_id: r.userId,
    event: r.success ? "delivered" : "bounced",
    timestamp: now,
    ...(r.error && {
      metadata: {
        bounce_type: "hard",
        reason: r.error,
        message_id: r.messageId,
      },
    }),
    ...(!r.error && r.messageId && {
      metadata: { message_id: r.messageId },
    }),
  }));

  const delivered = params.results.filter((r) => r.success).length;
  const bounced = params.results.filter((r) => !r.success).length;

  const summary: AnalyticsSummary = {
    total_sent: params.results.length,
    delivered,
    bounced,
  };

  return {
    campaign_id: params.campaignId,
    organization_id: params.organizationId,
    events,
    summary,
  };
}
