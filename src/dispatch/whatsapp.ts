import { emitEvent } from "../events/index.js";
import { computeTagSign } from "../events/tag-sign.js";
import { registerCampaignCallback } from "../events/campaign-callback-registry.js";
import { resolveAnalyticsCallbackUrl } from "../events/resolve-analytics-callback-url.js";
import { componentLogger } from "../logging/logger.js";
import { LogComponent } from "../logging/conventions.js";
import {
  buildWhatsAppMediaMessageForUser,
  buildWhatsAppMessageForUser,
  parseWhatsAppMediaSpec,
  parseWhatsAppTemplateSpec,
  resolveDevTestRecipient,
  resolveRecipientPhone,
  resolveTemplateId,
} from "../providers/gupshup-whatsapp.js";
import {
  parseFreshchatTemplateSpec,
  resolveFreshchatDevTestRecipient,
} from "../providers/freshchat-whatsapp.js";
import {
  resolveSenderChainForRecipient,
  sendWithFailover,
} from "../providers/senders.js";
import { telemetry } from "../telemetry/posthog.js";
import { lookupUsers } from "../user-lookup.js";
import { programOf } from "../db/repos/dispatch-programs.js";
import { SendLogRecorder } from "./send-log-recorder.js";
import { deriveTemplateRef } from "./template-ref.js";
import type { DispatchPayload } from "./types.js";

const log = componentLogger(LogComponent.dispatchWhatsapp);

/**
 * Returns the same `{ sent, failed }` shape as the email path so the caller can
 * complete the dispatch run with real counts. Before this, WhatsApp runs stored
 * NULL for both and were invisible in every rollup.
 */
export async function processWhatsAppDispatch(
  payload: DispatchPayload,
  dispatchRunId?: string
): Promise<{ sent: number; failed: number }> {
  const { campaign_id, user_ids, content, metadata } = payload;

  log.info(
    { recipients: user_ids.length, channel: "whatsapp" },
    "Dispatch started"
  );

  const mediaSpec = parseWhatsAppMediaSpec(content, payload.images);
  let templateSpec = mediaSpec ? null : parseWhatsAppTemplateSpec(content);

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
  const devRecipient = resolveDevTestRecipient() || resolveFreshchatDevTestRecipient();

  const program = programOf(payload);
  const sendLogs = new SendLogRecorder({
    dispatch_run_id: dispatchRunId,
    campaign_id,
    program_id: program.program_id,
    step_id: program.step_id,
    organization_id: metadata.organization_id ?? null,
    channel: "whatsapp",
    provider: metadata.sender_id || "whatsapp",
    // Unlike email, this is a real provider-registered template id.
    template_ref: deriveTemplateRef(
      payload,
      templateSpec ? resolveTemplateId(templateSpec) : null
    ),
  });

  const sendResults: Array<{
    userId: string;
    success: boolean;
    senderId?: string;
    messageId?: string;
    error?: string;
  }> = [];
  let unresolved = 0;
  let missingPhone = 0;
  let failureCount = 0;

  for (const userId of user_ids) {
    const user = users.get(userId);
    if (!user) {
      unresolved += 1;
      log.debug({ user_id: userId }, "Recipient not found in user lookup — skipped");
      sendLogs.add({
        user_id: userId,
        status: "failed",
        error_category: "user_not_found",
        error_message: `User ${userId} not found in user lookup — skipped`,
      });
      continue;
    }

    const phone = resolveRecipientPhone(user, devRecipient);
    if (!phone) {
      missingPhone += 1;
      log.debug({ user_id: userId }, "Recipient has no phone number — skipped");
      sendResults.push({
        userId,
        success: false,
        error: "missing phone number",
      });
      sendLogs.add({
        user_id: userId,
        status: "failed",
        error_category: "missing_phone",
        error_message: "recipient has no phone number",
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

    const chain = resolveSenderChainForRecipient(
      userId,
      "whatsapp",
      metadata.organization_id,
      {
        sender_id: metadata.sender_id,
        sender_strict: metadata.sender_strict,
      }
    );

    if (chain.length === 0) {
      unresolved += 1;
      log.warn(
        { user_id: userId, organization_id: metadata.organization_id },
        "No enabled sender found for organization on WhatsApp channel"
      );
      sendLogs.add({
        user_id: userId,
        status: "failed",
        error_category: "no_sender_for_organization",
        error_message: `No WhatsApp sender configured for org ${metadata.organization_id}`,
      });
      await emitWhatsAppEvent({
        campaign_id,
        userId,
        metadata,
        resolvedAnalyticsUrl,
        payload,
        success: false,
        error: "no_sender_for_organization",
      });
      continue;
    }

    if (!mediaSpec && !templateSpec) {
      const senderDefaultTemplate =
        chain[0]?.config.gupshup?.default_template ||
        chain[0]?.config.freshchat?.default_template;
      templateSpec = parseWhatsAppTemplateSpec(content, senderDefaultTemplate);
      if (!templateSpec) {
        const freshchatSpec = parseFreshchatTemplateSpec(
          content,
          payload.images,
          senderDefaultTemplate
        );
        if (freshchatSpec) {
          templateSpec = {
            id: freshchatSpec.template_id,
            template_id: freshchatSpec.template_id,
            params: freshchatSpec.params,
          };
        }
      }
      if (!templateSpec) {
        throw new Error(
          "WhatsApp dispatch requires content.caption (+ media_url), template JSON in content.text_body/html_body, " +
            "sender default_template, or default template in env"
        );
      }
    }

    if (devRecipient) {
      log.warn(
        { dev_mode: true },
        "DEV mode — routing all WhatsApp recipients to test recipient"
      );
    }

    const sendContext = {
      campaign_id,
      user_id: userId,
      dispatch_id: payload.dispatch_ids?.[userId],
      organization_id: metadata.organization_id,
      analytics_callback_url: resolvedAnalyticsUrl,
    };

    const freshchatSpec = parseFreshchatTemplateSpec(
      content,
      payload.images,
      chain[0]?.config.freshchat?.default_template
    );

    const message: any = mediaSpec
      ? {
          ...buildWhatsAppMediaMessageForUser(
            mediaSpec,
            user,
            phone,
            personalizeCtx,
            sendContext
          ),
          user,
          personalizeCtx,
          freshchatSpec: freshchatSpec ?? undefined,
        }
      : {
          ...buildWhatsAppMessageForUser(
            templateSpec!,
            user,
            phone,
            personalizeCtx,
            sendContext
          ),
          user,
          personalizeCtx,
          freshchatSpec: freshchatSpec ?? undefined,
        };

    const sendStartedAt = performance.now();
    const result = await sendWithFailover(message, chain, "whatsapp");
    const latencyMs = Math.round(performance.now() - sendStartedAt);

    if (!result.success) {
      telemetry.capture("dispatcher_provider_send_failed", {
        provider: result.finalSender.config.provider,
        channel: "whatsapp",
      });
      const level = failureCount === 0 ? "warn" : "debug";
      failureCount += 1;
      log[level](
        {
          user_id: userId,
          sender_id: result.finalSender.config.id,
          provider: result.finalSender.config.provider,
          error_category: result.error_category || "delivery_failure",
          error_message: result.error ?? "provider send failed",
          duration_ms: latencyMs,
        },
        failureCount === 1
          ? "Provider rejected a message — first failure of this run"
          : "Provider rejected a message"
      );
    }
    sendLogs.add({
      user_id: userId,
      status: result.success ? "sent" : "failed",
      provider_message_id: result.messageId ?? null,
      latency_ms: latencyMs,
      ...(result.success
        ? {}
        : {
            error_category: result.error_category || "delivery_failure",
            error_message: result.error ?? "provider send failed",
          }),
      fallbacks_used: result.attempts.length > 1 ? result.attempts.length - 1 : 0,
    });
    sendResults.push({
      userId,
      success: result.success,
      senderId: result.finalSender.config.id,
      messageId: result.messageId,
      error: result.error,
    });

    await emitWhatsAppEvent({
      campaign_id,
      userId,
      metadata,
      resolvedAnalyticsUrl,
      payload,
      provider: result.finalSender.config.provider,
      senderId: result.finalSender.config.id,
      success: result.success,
      messageId: result.messageId,
      error: result.error,
    });

    if (devRecipient) break;
  }

  sendLogs.flush();

  const sent = sendResults.filter((r) => r.success).length;
  const failed = sendResults.filter((r) => !r.success).length;

  if (missingPhone > 0) {
    log.warn(
      { channel: "whatsapp", missing_phone: missingPhone, requested: user_ids.length },
      `${missingPhone} of ${user_ids.length} recipients had no phone number`
    );
  }
  log[failed > 0 ? "warn" : "info"](
    {
      channel: "whatsapp",
      requested: user_ids.length,
      sent,
      failed,
      unresolved,
      missing_phone: missingPhone,
    },
    `Dispatch completed — ${sent} sent, ${failed} failed`
  );
  telemetry.capture("dispatcher_dispatch_completed", {
    channel: "whatsapp",
    requested_count: user_ids.length,
    resolved_count: sendResults.length,
    sent_count: sent,
    failed_count: failed,
  });
  return { sent, failed };
}

async function emitWhatsAppEvent(args: {
  campaign_id: string;
  userId: string;
  metadata: DispatchPayload["metadata"];
  resolvedAnalyticsUrl: string;
  payload: DispatchPayload;
  provider?: string;
  senderId?: string;
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
    provider = "gupshup",
    senderId,
    success,
    messageId,
    error,
  } = args;

  // A "successful" send with no provider message id can't be correlated to later
  // GatewayAPI delivery receipts (dispatch_message_map is keyed on it), so emit a
  // failed event with an explicit reason instead of an uncorrelatable "dispatched".
  const hasMessageId = typeof messageId === "string" && messageId.length > 0;
  if (success && !hasMessageId) {
    log.warn(
      { user_id: userId, provider, error_category: "noProviderMessageId" },
      "Provider accepted the message but returned no message id — recording it as failed, " +
        "because delivery receipts are keyed on that id and could never be correlated"
    );
  }
  const effectiveSuccess = success && hasMessageId;
  const effectiveError =
    success && !hasMessageId ? "noProviderMessageId" : error;

  const dispatch_id = payload.dispatch_ids?.[userId];

  // `smsign_<sig>` is the same HMAC placed on outbound provider tags.
  // Forwarded so the backend — which recovers campaign/user/org by externalId —
  // can recompute it and confirm the event originated from a message we sent.
  const sign = computeTagSign({
    campaign_id,
    user_id: userId,
    organization_id: metadata.organization_id,
  });

  await emitEvent({
    callbackUrl: resolvedAnalyticsUrl,
    event: {
      campaign_id,
      user_id: userId,
      organization_id: metadata.organization_id,
      analytics_callback_url: resolvedAnalyticsUrl,
      channel: "whatsapp",
      event: effectiveSuccess ? "dispatched" : "failed",
      provider: provider as any,
      provider_message_id: messageId ?? "unknown",
      occurred_at: new Date().toISOString(),
      metadata: {
        ...(effectiveError ? { bounce_reason: effectiveError } : {}),
        ...(senderId ? { sender_id: senderId } : {}),
        ...(dispatch_id ? { dispatch_id } : {}),
        ...(sign ? { sign } : {}),
      },
    },
  });

  log.debug(
    {
      user_id: userId,
      event: effectiveSuccess ? "dispatched" : "failed",
      provider_message_id: messageId ?? null,
    },
    "Send event emitted"
  );
}
