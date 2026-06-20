import { emitEvent } from "../events/index.js";
import { registerCampaignCallback } from "../events/campaign-callback-registry.js";
import { resolveAnalyticsCallbackUrl } from "../events/resolve-analytics-callback-url.js";
import { logUnlessVitest, warnUnlessVitest } from "../logging.js";
import {
  buildWhatsAppMediaMessageForUser,
  buildWhatsAppMessageForUser,
  GupshupWhatsAppProvider,
  parseWhatsAppMediaSpec,
  parseWhatsAppTemplateSpec,
  resolveDevTestRecipient,
  resolveRecipientPhone,
} from "../providers/gupshup-whatsapp.js";
import { lookupUsers } from "../user-lookup.js";
import type { DispatchPayload } from "./types.js";

export async function processWhatsAppDispatch(
  payload: DispatchPayload
): Promise<void> {
  const { campaign_id, user_ids, content, metadata } = payload;

  logUnlessVitest(
    `[Dispatch] Processing WhatsApp campaign ${campaign_id}: ${user_ids.length} users`
  );

  const mediaSpec = parseWhatsAppMediaSpec(content, payload.images);
  const templateSpec = mediaSpec ? null : parseWhatsAppTemplateSpec(content);

  if (!mediaSpec && !templateSpec) {
    throw new Error(
      "WhatsApp dispatch requires content.caption (+ media_url), template JSON in content.text_body/html_body, " +
        "GUPSHUP_DEFAULT_TEMPLATE / GUPSHUP_EVENT_TEST_TEMPLATE env, or " +
        "GUPSHUP_EVENT_TEST_CAPTION + GUPSHUP_EVENT_TEST_MEDIA_URL for GatewayAPI media send"
    );
  }

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
  const provider = new GupshupWhatsAppProvider();
  const devRecipient = resolveDevTestRecipient();

  const sendResults: Array<{
    userId: string;
    success: boolean;
    messageId?: string;
    error?: string;
  }> = [];

  for (const userId of user_ids) {
    const user = users.get(userId);
    if (!user) {
      warnUnlessVitest(`[Dispatch] User ${userId} not found in database, skipping`);
      continue;
    }

    const phone = resolveRecipientPhone(user, devRecipient);
    if (!phone) {
      warnUnlessVitest(
        `[Dispatch] User ${userId} has no phone number, skipping WhatsApp send`
      );
      sendResults.push({
        userId,
        success: false,
        error: "missing phone number",
      });
      await emitWhatsAppEvent({
        campaign_id,
        userId,
        metadata,
        resolvedAnalyticsUrl,
        payload,
        success: false,
        error: "missing phone number",
      });
      continue;
    }

    if (devRecipient) {
      logUnlessVitest(
        `[Dispatch] DEV mode — routing all WhatsApp recipients to ${devRecipient} (GUPSHUP_EVENT_TEST_RECIPIENTS)`
      );
    }

    const sendContext = {
      campaign_id,
      user_id: userId,
      dispatch_id: payload.dispatch_ids?.[userId],
      organization_id: metadata.organization_id,
      analytics_callback_url: resolvedAnalyticsUrl,
    };

    const message = mediaSpec
      ? buildWhatsAppMediaMessageForUser(
          mediaSpec,
          user,
          phone,
          personalizeCtx,
          sendContext
        )
      : buildWhatsAppMessageForUser(
          templateSpec!,
          user,
          phone,
          personalizeCtx,
          sendContext
        );

    const result = await provider.send(message);
    sendResults.push({
      userId,
      success: result.success,
      messageId: result.messageId,
      error: result.error,
    });

    await emitWhatsAppEvent({
      campaign_id,
      userId,
      metadata,
      resolvedAnalyticsUrl,
      payload,
      success: result.success,
      messageId: result.messageId,
      error: result.error,
    });

    if (devRecipient) break;
  }

  const sent = sendResults.filter((r) => r.success).length;
  const failed = sendResults.filter((r) => !r.success).length;

  logUnlessVitest(
    `[Dispatch] WhatsApp campaign ${campaign_id}: ${sent} sent, ${failed} failed (events emitted via pipeline)`
  );
}

async function emitWhatsAppEvent(args: {
  campaign_id: string;
  userId: string;
  metadata: DispatchPayload["metadata"];
  resolvedAnalyticsUrl: string;
  payload: DispatchPayload;
  success: boolean;
  messageId?: string;
  error?: string;
}): Promise<void> {
  const {
    campaign_id,
    userId,
    metadata,
    resolvedAnalyticsUrl,
    payload,
    success,
    messageId,
    error,
  } = args;

  await emitEvent({
    callbackUrl: resolvedAnalyticsUrl,
    event: {
      campaign_id,
      user_id: userId,
      organization_id: metadata.organization_id,
      analytics_callback_url: resolvedAnalyticsUrl,
      channel: "whatsapp",
      event: success ? "dispatched" : "failed",
      provider: "gupshup",
      provider_message_id: messageId ?? "unknown",
      occurred_at: new Date().toISOString(),
      metadata: {
        ...(error ? { bounce_reason: error } : {}),
        ...(payload.dispatch_ids?.[userId]
          ? { dispatch_id: payload.dispatch_ids[userId] }
          : {}),
      },
    },
  });

  logUnlessVitest(
    `[Dispatch] event emitted user=${userId} event=${success ? "dispatched" : "failed"} messageId=${messageId ?? "unknown"}`
  );
}
