import type { SendContext } from "../../providers/types.js";

export type GupshupTaggedMessage = {
  tag: string;
};

/** Gupshup io API: `tag` JSON echoed on message-event webhooks. Enterprise uses `extra`. */
export function applyGupshupTag(
  _message: Record<string, unknown>,
  ctx: SendContext
): GupshupTaggedMessage {
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
