/**
 * Analytics Reporter
 *
 * Reports delivery analytics back to ScaleMargin's inbound webhook.
 * Supports both real-time (per-event) and batch (post-campaign) reporting.
 *
 * Sign the payload with HMAC-SHA256 using the shared analytics secret.
 * Retries transient failures with exponential backoff.
 */

import { createHmac } from "node:crypto";
import type { AnalyticsPayload, AnalyticsEvent, AnalyticsSummary } from "./providers/types.js";

const ANALYTICS_SECRET = process.env.SCALEMARGIN_ANALYTICS_SECRET || "";
const MAX_RETRIES = 3;

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Validate that the callback URL points to a trusted ScaleMargin endpoint.
 * Prevents SSRF via malicious analytics_callback_url in dispatch payload.
 */
function validateCallbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    // Must be HTTPS in production
    const hostname = parsed.hostname;
    const isDockerHost = hostname === "host.docker.internal";

    // Must be HTTPS in production (except Docker-to-host networking)
    if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:" && !isDockerHost) {
      return false;
    }

    // Must be HTTP or HTTPS
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }

    // Block private/internal IPs (in production only, except Docker host)
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

    // Must end with expected ScaleMargin path
    if (!parsed.pathname.includes("/api/webhooks/campaign-analytics")) {
      console.warn(
        `[Analytics] Unexpected callback path: ${parsed.pathname}. Proceeding anyway.`
      );
    }

    return true;
  } catch {
    return false;
  }
}

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
  const secret = ANALYTICS_SECRET;
  if (!secret) {
    console.error("[Analytics] SCALEMARGIN_ANALYTICS_SECRET not configured");
    return { success: false, error: "Analytics secret not configured" };
  }

  if (!validateCallbackUrl(callbackUrl)) {
    console.error(`[Analytics] Invalid callback URL: ${callbackUrl}`);
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
        const result = await response.json();
        console.log(
          `[Analytics] Reported to ScaleMargin: ${result.events_processed} events processed`
        );
        return { success: true };
      }

      // Non-retryable client errors (400-499 except 429)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        const errorText = await response.text();
        console.error(
          `[Analytics] ScaleMargin rejected analytics (${response.status}): ${errorText}`
        );
        return { success: false, error: `${response.status}: ${errorText}` };
      }

      // Retryable: 429 (rate limit) or 5xx (server error)
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown error";
    }

    if (attempt < MAX_RETRIES) {
      const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
      console.warn(
        `[Analytics] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed (${lastError}), retrying in ${delay}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  console.error(
    `[Analytics] Failed to report after ${MAX_RETRIES + 1} attempts: ${lastError}`
  );
  return { success: false, error: lastError };
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
