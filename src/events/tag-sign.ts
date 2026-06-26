/**
 * ScaleMargin tag signature (`smsign_<sig>`).
 *
 * Gupshup Enterprise echoes a `extra` field (io API: `tag`) back on delivery
 * webhooks, but it is capped at 50 characters — too short to carry the
 * correlation IDs (campaign/user/org are UUIDs) plus a callback URL. Instead we
 * place a compact keyed signature on the wire and resolve the full correlation
 * by looking the signature back up (see {@link ./sign-registry.js}).
 *
 * The signature is an authenticity stamp:
 *   - The `smsign_` prefix identifies our own events vs foreign / generic
 *     provider test events.
 *   - The HMAC keying (SCALEMARGIN_ANALYTICS_SECRET) makes it unforgeable.
 * It is also forwarded on the dispatched analytics event so the backend — which
 * recovers campaign/user/org by externalId — can recompute it and confirm the
 * event originated from a message we sent.
 *
 * Wire size: "smsign_" (7) + 32 hex chars = 39, comfortably within the 50-char
 * `extra` limit.
 */

import { createHmac } from "node:crypto";

export const SMSIGN_PREFIX = "smsign_";

/** Truncated HMAC length (hex chars). 32 hex = 16 bytes = 128 bits. */
const SIG_HEX_LEN = 32;

/** Whole `smsign_<sig>` wire value stays within Gupshup Enterprise `extra`'s limit. */
export const SMSIGN_MAX_WIRE_LEN = 50;

/**
 * Correlation tuple signed into the tag. Only the three stable IDs the backend
 * recovers by externalId — NOT dispatch_id (optional, and the backend would have
 * to reproduce it byte-identically to recompute the signature).
 */
export interface TagSignInput {
  campaign_id: string;
  user_id: string;
  organization_id: string;
}

/** Stable, order-fixed string fed to the HMAC. */
function canonical(input: TagSignInput): string {
  return [input.campaign_id, input.user_id, input.organization_id].join("|");
}

function signingSecret(): string {
  return process.env.SCALEMARGIN_ANALYTICS_SECRET || "";
}

/**
 * Deterministic truncated HMAC over the correlation tuple. Returns "" when no
 * signing secret is configured, which callers treat as "signing disabled".
 */
export function computeTagSign(input: TagSignInput): string {
  const secret = signingSecret();
  if (!secret) return "";
  return createHmac("sha256", secret)
    .update(canonical(input))
    .digest("hex")
    .slice(0, SIG_HEX_LEN);
}
