import { recordRecipientFailure } from "../admin/activity.js";
import { hasDevSentCampaign, markDevSentCampaign } from "../db/repos/dev-sent.js";
import { emitEvent } from "../events/index.js";
import { registerCampaignCallback } from "../events/campaign-callback-registry.js";
import { resolveAnalyticsCallbackUrl } from "../events/resolve-analytics-callback-url.js";
import { processImages, type ImageMapping } from "../images/handler.js";
import { rewriteImageUrls } from "../images/rewriter.js";
import { logUnlessVitest, warnUnlessVitest } from "../logging.js";
import { personalize } from "../personalize.js";
import { getProvider } from "../providers/index.js";
import type { EmailMessage } from "../providers/types.js";
import { telemetry } from "../telemetry/posthog.js";
import { lookupUsers } from "../user-lookup.js";
import { ensurePlaceholdersFresh } from "../variables/service.js";
import { processWhatsAppDispatch } from "./whatsapp.js";
import type { DispatchPayload } from "./types.js";

export type { DispatchPayload } from "./types.js";

export async function processDispatch(
  payload: DispatchPayload,
  fromEmail: string,
  dispatchRunId?: string
): Promise<{ sent: number; failed: number } | undefined> {
  // Pick up variable edits made via the admin API since the last dispatch —
  // one refresh per campaign so the whole run uses a consistent set.
  await ensurePlaceholdersFresh();

  if (payload.channel === "whatsapp") {
    await processWhatsAppDispatch(payload);
    return undefined;
  }

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

  if (devRecipient && (await hasDevSentCampaign(campaign_id))) {
    logUnlessVitest(
      `[Dispatch] DEV mode — campaign ${campaign_id} already routed to ${devRecipient} this run, skipping`
    );
    return { sent: 0, failed: 0 };
  }

  const messages: Array<{ userId: string; message: EmailMessage }> = [];

  for (const userId of user_ids) {
    const user = users.get(userId);
    if (!user) {
      warnUnlessVitest(`[Dispatch] User ${userId} not found in database, skipping`);
      if (dispatchRunId) {
        recordRecipientFailure({
          dispatch_run_id: dispatchRunId,
          campaign_id,
          user_id: userId,
          provider: provider.name,
          error_category: "user_not_found",
          error_message: `User ${userId} not found in user lookup — skipped`,
        });
      }
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
      await markDevSentCampaign(campaign_id);
      logUnlessVitest(
        `[Dispatch] DEV mode — routing campaign ${campaign_id} (${user_ids.length} recipients) to ${devRecipient}, one email per campaign`
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
    if (!result.success) {
      telemetry.capture("dispatcher_provider_send_failed", {
        provider: provider.name,
        channel: "email",
      });
      if (dispatchRunId) {
        recordRecipientFailure({
          dispatch_run_id: dispatchRunId,
          campaign_id,
          user_id: userId,
          provider: provider.name,
          error_category: "delivery_failure",
          error_message: result.error ?? "provider send failed",
        });
      }
    }
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
  telemetry.capture("dispatcher_dispatch_completed", {
    channel: "email",
    provider: provider.name,
    requested_count: user_ids.length,
    resolved_count: messages.length,
    sent_count: sent,
    failed_count: failed,
    image_count: payload.images?.length ?? 0,
  });
  return { sent, failed };
}
