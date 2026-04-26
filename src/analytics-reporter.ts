/**
 * Analytics Reporter
 *
 * Reports delivery analytics back to ScaleMargin's inbound webhook.
 * Supports both real-time (per-event) and batch (post-campaign) reporting.
 *
 * Sign the payload with HMAC-SHA256 using the shared analytics secret.
 * Retries transient failures with exponential backoff.
 *
 * Core signing / POST / retry logic lives in `events/forwarder.ts` (shared with the event pipeline).
 */

import type { AnalyticsPayload, AnalyticsEvent, AnalyticsSummary } from "./providers/types.js";
import { postAnalyticsWithRetry } from "./events/forwarder.js";

const ANALYTICS_SECRET = process.env.SCALEMARGIN_ANALYTICS_SECRET || "";

/**
 * Report analytics to ScaleMargin with retry logic.
 *
 * @param callbackUrl - ScaleMargin analytics webhook URL
 *   (from metadata.analytics_callback_url in the dispatch payload)
 * @param payload - Analytics data (events and/or summary)
 */
export async function reportAnalytics(
  callbackUrl: string,
  payload: AnalyticsPayload
): Promise<{ success: boolean; error?: string }> {
  return postAnalyticsWithRetry(callbackUrl, payload, ANALYTICS_SECRET);
}

/**
 * Build a batch analytics payload from send results.
 *
 * Call this after sending a campaign to report delivery results
 * back to ScaleMargin in a single batch.
 *
 * @deprecated Prefer the event pipeline (`emitEvent`) for standardized `dispatched` / `failed` events.
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
    channel: "email",
    ...(r.error && {
      metadata: {
        bounce_type: "hard",
        reason: r.error,
        message_id: r.messageId,
      },
    }),
    ...(!r.error &&
      r.messageId && {
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
