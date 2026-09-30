/**
 * Forward correlation-free Freshchat WhatsApp delivery receipts (READ / DELIVERED /
 * FAILED …) to the ScaleMargin backend.
 */

import { componentLogger } from "../../logging/logger.js";
import { signPayload } from "../forwarder.js";
import type { FreshchatReceipt } from "./adapter.js";
import { NO_RECEIPTS_URL_HINT, resolveWhatsAppReceiptsUrl } from "../gupshup/receipt-forwarder.js";

const log = componentLogger("events.freshchat");

const MAX_RETRIES = 3;

/** `status` is set only when ScaleMargin refused the batch outright (4xx other than 429). */
export type ForwardResult = { success: boolean; error?: string; status?: number };

export async function forwardFreshchatReceipts(
  receipts: FreshchatReceipt[],
  secret: string
): Promise<ForwardResult> {
  if (receipts.length === 0) return { success: true };

  const url = resolveWhatsAppReceiptsUrl();
  if (!url) {
    log.warn(
      `[FreshchatReceipts] Dropping ${receipts.length} receipt(s): ${NO_RECEIPTS_URL_HINT}`
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
        return { success: false, error: `${response.status}: ${errorText}`, status: response.status };
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

/** ScaleMargin's answers that are about the receipts themselves, not the endpoint. */
const RECEIPT_REFUSAL = /Drip step not found|Campaign not found|No matching authenticated receipts/i;

export type IsolatedForward = {
  /** ScaleMargin accepted these. */
  accepted: FreshchatReceipt[];
  /** Refused on their own (4xx) — resending can never help; drop them. */
  rejected: Array<{ receipt: FreshchatReceipt; error: string }>;
  /** Not delivered for a passing reason (5xx, network, no URL/secret) — retry later. */
  failed: FreshchatReceipt[];
  /** The first passing error, when `failed` is not empty. */
  error?: string;
};

/**
 * Forward receipts so one bad receipt cannot sink the rest. When ScaleMargin
 * refuses a batch outright (a 4xx — e.g. 404 "Drip step not found" because one
 * message's drip was deleted after it was sent), the batch is split in halves
 * until the refused receipts are on their own; everything else still goes
 * through, in order. A passing failure (5xx, network) is not split — the whole
 * batch is retried later, exactly as before.
 *
 * A receipt only counts as refused on its own with proof it is the receipt:
 * others in the same run were accepted, or ScaleMargin's answer names it
 * (RECEIPT_REFUSAL). Otherwise — a 401/403, or everything refused with an
 * unexplained 4xx (wrong analytics URL, rotated secret) — it is a failure to
 * retry: dropping every message because the endpoint is misconfigured would
 * lose them all.
 */
export async function forwardFreshchatReceiptsIsolating(
  receipts: FreshchatReceipt[],
  secret: string,
  forward: (receipts: FreshchatReceipt[], secret: string) => Promise<ForwardResult> = forwardFreshchatReceipts
): Promise<IsolatedForward> {
  const out: IsolatedForward = { accepted: [], rejected: [], failed: [] };
  const run = async (batch: FreshchatReceipt[]): Promise<void> => {
    if (batch.length === 0) return;
    const result = await forward(batch, secret);
    if (result.success) {
      out.accepted.push(...batch);
      return;
    }
    if (result.status === undefined || result.status === 401 || result.status === 403) {
      out.failed.push(...batch);
      out.error ??= result.error;
      return;
    }
    if (batch.length === 1) {
      out.rejected.push({ receipt: batch[0]!, error: result.error ?? `HTTP ${result.status}` });
      return;
    }
    const mid = Math.ceil(batch.length / 2);
    await run(batch.slice(0, mid));
    await run(batch.slice(mid));
  };
  await run(receipts);
  if (out.accepted.length === 0) {
    const unproven = out.rejected.filter((r) => !RECEIPT_REFUSAL.test(r.error));
    if (unproven.length > 0) {
      out.rejected = out.rejected.filter((r) => RECEIPT_REFUSAL.test(r.error));
      out.failed.push(...unproven.map((r) => r.receipt));
      out.error ??= unproven[0]!.error;
    }
  }
  if (out.rejected.length > 0) {
    log.warn(
      { rejected: out.rejected.length, accepted: out.accepted.length, request_ids: out.rejected.map((r) => r.receipt.external_id).slice(0, 20) },
      `[FreshchatReceipts] ScaleMargin refused ${out.rejected.length} receipt(s) on their own — dropped; the other ${out.accepted.length} were delivered`
    );
  }
  return out;
}

