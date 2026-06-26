import type { SendContext } from "../../providers/types.js";
import { computeTagSign, SMSIGN_PREFIX } from "../tag-sign.js";

export type GupshupTaggedMessage = {
  tag: string;
};

/**
 * Gupshup io API: `tag` JSON echoed on message-event webhooks. Enterprise uses `extra`.
 *
 * When a signing secret (SCALEMARGIN_ANALYTICS_SECRET) is configured, the wire
 * value is a compact `smsign_<sig>` token that fits the 50-char Enterprise `extra`
 * limit and identifies our own events. Correlation + validation happen on the
 * backend: it recovers campaign/user/org by externalId and recomputes the same
 * signature (forwarded on the dispatched event) to confirm authenticity. With no
 * secret, falls back to the legacy self-contained JSON tag.
 */
export function applyGupshupTag(
  _message: Record<string, unknown>,
  ctx: SendContext
): GupshupTaggedMessage {
  const sig = computeTagSign(ctx);
  if (sig) {
    return { tag: SMSIGN_PREFIX + sig };
  }
  return {
    tag: JSON.stringify({
      campaign_id: ctx.campaign_id,
      user_id: ctx.user_id,
      ...(ctx.dispatch_id ? { dispatch_id: ctx.dispatch_id } : {}),
      organization_id: ctx.organization_id,
      analytics_callback_url: ctx.analytics_callback_url,
    }),
  };
}
