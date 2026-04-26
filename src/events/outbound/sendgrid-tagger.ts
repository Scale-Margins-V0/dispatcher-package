import type { SendContext } from "../../providers/types.js";

export type SendGridTaggedMessage<T extends Record<string, unknown>> = T & {
  customArgs: {
    campaign_id: string;
    user_id: string;
    dispatch_id?: string;
    organization_id: string;
    analytics_callback_url: string;
  };
};

/** SendGrid Mail API: customArgs echoed on every event webhook. */
export function applySendGridCustomArgs<T extends Record<string, unknown>>(
  message: T,
  ctx: SendContext
): SendGridTaggedMessage<T> {
  return {
    ...message,
    customArgs: {
      campaign_id: ctx.campaign_id,
      user_id: ctx.user_id,
      ...(ctx.dispatch_id ? { dispatch_id: ctx.dispatch_id } : {}),
      organization_id: ctx.organization_id,
      analytics_callback_url: ctx.analytics_callback_url,
    },
  };
}
