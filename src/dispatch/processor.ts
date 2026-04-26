import { emitEvent } from "../events/index.js";
import { registerCampaignCallback } from "../events/campaign-callback-registry.js";
import { resolveAnalyticsCallbackUrl } from "../events/resolve-analytics-callback-url.js";
import { processImages, type ImageMapping } from "../images/handler.js";
import { rewriteImageUrls } from "../images/rewriter.js";
import { logUnlessVitest, warnUnlessVitest } from "../logging.js";
import { personalize } from "../personalize.js";
import { getProvider } from "../providers/index.js";
import type { EmailMessage } from "../providers/types.js";
import { lookupUsers } from "../user-lookup.js";

export type DispatchPayload = {
  campaign_id: string;
  channel: string;
  user_ids: string[];
  dispatch_ids?: Record<string, string>;
  content: {
    subject?: string;
    html_body?: string;
    text_body?: string;
  };
  personalization_fields?: string[];
  images?: Array<{
    placeholder: string;
    url: string;
    raw_url: string;
    content_type: string;
    alt_text?: string;
    base64_data?: string;
  }>;
  metadata: {
    organization_id: string;
    analytics_callback_url: string;
  };
};

export async function processDispatch(
  payload: DispatchPayload,
  fromEmail: string
): Promise<void> {
  const { campaign_id, user_ids, content, metadata } = payload;

  logUnlessVitest(
    `[Dispatch] Processing campaign ${campaign_id}: ${user_ids.length} users`
  );

  const resolvedAnalyticsUrl =
    resolveAnalyticsCallbackUrl({
      campaignId: campaign_id,
      correlationCallbackUrl: metadata.analytics_callback_url,
    }) ?? metadata.analytics_callback_url;

  registerCampaignCallback(
    campaign_id,
    metadata.organization_id,
    resolvedAnalyticsUrl
  );

  const personalizeCtx = {
    campaign_id,
    organization_id: metadata.organization_id,
  };

  const users = await lookupUsers(user_ids);

  let imageMappings: ImageMapping[] = [];
  if (payload.images && payload.images.length > 0) {
    imageMappings = await processImages(payload.images, campaign_id);
  }

  const provider = getProvider();
  const devRecipient = process.env.DEV_RECIPIENT_EMAIL;
  const messages: Array<{ userId: string; message: EmailMessage }> = [];

  for (const userId of user_ids) {
    const user = users.get(userId);
    if (!user) {
      warnUnlessVitest(`[Dispatch] User ${userId} not found in database, skipping`);
      continue;
    }

    const subject = content.subject
      ? personalize(content.subject, user, personalizeCtx)
      : "No Subject";
    let html = content.html_body
      ? personalize(content.html_body, user, personalizeCtx)
      : "";

    if (imageMappings.length > 0) {
      html = rewriteImageUrls(html, imageMappings);
    }

    const recipientEmail = devRecipient || user.email;

    messages.push({
      userId,
      message: {
        to: recipientEmail,
        from: fromEmail,
        subject,
        html,
        ...(content.text_body && {
          text: personalize(content.text_body, user, personalizeCtx),
        }),
        context: {
          campaign_id,
          user_id: userId,
          dispatch_id: payload.dispatch_ids?.[userId],
          organization_id: metadata.organization_id,
          analytics_callback_url: resolvedAnalyticsUrl,
        },
      },
    });

    if (devRecipient) {
      logUnlessVitest(
        `[Dispatch] DEV mode — routing all ${user_ids.length} recipients to ${devRecipient}`
      );
      break;
    }
  }

  logUnlessVitest(`[Dispatch] Sending ${messages.length} emails via ${provider.name}`);

  const sendResults: Array<{
    userId: string;
    success: boolean;
    messageId?: string;
    error?: string;
  }> = [];

  for (const { userId, message } of messages) {
    const result = await provider.send(message);
    sendResults.push({
      userId,
      success: result.success,
      messageId: result.messageId,
      error: result.error,
    });

    const emailProvider = (process.env.EMAIL_PROVIDER || "ses").toLowerCase();
    const inboundProvider = emailProvider === "sendgrid" ? "sendgrid" : "ses";

    await emitEvent({
      callbackUrl: resolvedAnalyticsUrl,
      event: {
        campaign_id,
        user_id: userId,
        organization_id: metadata.organization_id,
        analytics_callback_url: resolvedAnalyticsUrl,
        channel: "email",
        event: result.success ? "dispatched" : "failed",
        provider: inboundProvider,
        provider_message_id: result.messageId ?? "unknown",
        occurred_at: new Date().toISOString(),
        metadata: {
          ...(result.error ? { bounce_reason: result.error } : {}),
          ...(payload.dispatch_ids?.[userId]
            ? { dispatch_id: payload.dispatch_ids[userId] }
            : {}),
        },
      },
    });
    logUnlessVitest(
      `[Dispatch] event emitted user=${userId} event=${result.success ? "dispatched" : "failed"} messageId=${result.messageId ?? "unknown"}`
    );
  }

  const sent = sendResults.filter((r) => r.success).length;
  const failed = sendResults.filter((r) => !r.success).length;

  logUnlessVitest(
    `[Dispatch] Campaign ${campaign_id}: ${sent} sent, ${failed} failed (events emitted via pipeline)`
  );
}
