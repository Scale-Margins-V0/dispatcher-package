/**
 * Forward correlation-free Gupshup WhatsApp delivery receipts (READ / DELIVERED /
 * FAILED …) to the ScaleMargin backend. These GatewayAPI receipts echo only the
 * outbound message id as `externalId` and carry no campaign tag, so the dispatcher
 * cannot resolve correlation locally.
 *
 * Posted to the same `/api/webhooks/campaign-analytics` endpoint as normal analytics
 * (discriminated by `channel: "whatsapp"` + a `receipts` array). The backend matches
 * `external_id` against the dispatched event's `metadata.provider_message_id` to
 * recover the campaign/enrollment, then records the new event.
 *
 * Signed with the same HMAC scheme as the analytics pipeline (SCALEMARGIN_ANALYTICS_SECRET);
 * the backend resolves the org from the matched dispatched event and verifies against
 * that org's analytics secret.
 */

import { signPayload } from "../forwarder.js";
import type { GupshupReceipt } from "./adapter.js";

const MAX_RETRIES = 3;

/**
 * Receipts have no campaign, so they cannot use a per-send analytics_callback_url.
 * Use the platform analytics URL (same endpoint as normal events), or an explicit override.
 */
export function resolveWhatsAppReceiptsUrl(): string | undefined {
  const explicit = process.env.SCALEMARGIN_WHATSAPP_RECEIPTS_URL?.trim();
  if (explicit) return explicit;
  return process.env.SCALEMARGIN_ANALYTICS_CALLBACK_URL?.trim() || undefined;
}

export async function forwardGupshupReceipts(
  receipts: GupshupReceipt[],
  secret: string
): Promise<{ success: boolean; error?: string }> {
  if (receipts.length === 0) return { success: true };

  const url = resolveWhatsAppReceiptsUrl();
  if (!url) {
    console.warn(
      `[GupshupReceipts] No receipts URL configured (set SCALEMARGIN_WHATSAPP_RECEIPTS_URL or SCALEMARGIN_ANALYTICS_CALLBACK_URL) — dropping ${receipts.length} receipt(s)`
    );
    return { success: false, error: "no receipts URL configured" };
  }
  if (!secret) {
    console.warn(
      `[GupshupReceipts] SCALEMARGIN_ANALYTICS_SECRET not configured — dropping ${receipts.length} receipt(s)`
    );
    return { success: false, error: "analytics secret not configured" };
  }

  const body = JSON.stringify({ channel: "whatsapp", receipts });
  const timestamp = new Date().toISOString();
  const signature = signPayload(body, secret);

  let lastError: string | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const started = performance.now();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ScaleMargin-Signature": `sha256=${signature}`,
          "X-ScaleMargin-Timestamp": timestamp,
        },
        body,
      });
      const elapsed = Math.round(performance.now() - started);
      console.log(
        `[GupshupReceipts] POST ${url} attempt=${attempt} status=${response.status} count=${receipts.length} elapsed=${elapsed}ms`
      );

      if (response.ok) return { success: true };

      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        const errorText = await response.text();
        console.warn(
          `[GupshupReceipts] permanent client error status=${response.status} body_preview=${JSON.stringify(errorText.slice(0, 200))}`
        );
        return { success: false, error: `${response.status}: ${errorText}` };
      }

      lastError = `HTTP ${response.status}`;
    } catch (error) {
      const elapsed = Math.round(performance.now() - started);
      lastError = error instanceof Error ? error.message : "Unknown error";
      console.warn(
        `[GupshupReceipts] POST ${url} attempt=${attempt} elapsed=${elapsed}ms network_error=${lastError}`
      );
    }

    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }

  return { success: false, error: lastError };
}
