/**
 * Forward correlation-free Freshchat WhatsApp delivery receipts (READ / DELIVERED /
 * FAILED …) to the ScaleMargin backend.
 */

import { componentLogger } from "../../logging/logger.js";
import { signPayload } from "../forwarder.js";
import type { FreshchatReceipt } from "./adapter.js";
import { resolveWhatsAppReceiptsUrl } from "../gupshup/receipt-forwarder.js";

const log = componentLogger("events.freshchat");

const MAX_RETRIES = 3;

export async function forwardFreshchatReceipts(
  receipts: FreshchatReceipt[],
  secret: string
): Promise<{ success: boolean; error?: string }> {
  if (receipts.length === 0) return { success: true };

  const url = resolveWhatsAppReceiptsUrl();
  if (!url) {
    log.warn(
      `[FreshchatReceipts] No backend analytics URL known yet — dropping ${receipts.length} receipt(s)`
    );
    return { success: false, error: "no receipts URL configured" };
  }
  if (!secret) {
    log.warn(
      `[FreshchatReceipts] SCALEMARGIN_ANALYTICS_SECRET not configured — dropping ${receipts.length} receipt(s)`
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
      log.info(
        `[FreshchatReceipts] POST ${url} attempt=${attempt} status=${response.status} count=${receipts.length} elapsed=${elapsed}ms`
      );

      if (response.ok) return { success: true };

      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        const errorText = await response.text();
        log.warn(
          `[FreshchatReceipts] permanent client error status=${response.status} body_preview=${JSON.stringify(errorText.slice(0, 200))}`
        );
        return { success: false, error: `${response.status}: ${errorText}` };
      }

      lastError = `HTTP ${response.status}`;
    } catch (error) {
      const elapsed = Math.round(performance.now() - started);
      lastError = error instanceof Error ? error.message : "Unknown error";
      log.warn(
        { err: error, attempt, elapsed_ms: elapsed },
        `[FreshchatReceipts] Network error forwarding receipts — attempt ${attempt}/${MAX_RETRIES}`
      );
    }

    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
    }
  }

  return { success: false, error: lastError };
}
