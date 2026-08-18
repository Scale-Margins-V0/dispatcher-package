import { emitEvent } from "../events/index.js";
import { computeTagSign } from "../events/tag-sign.js";
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
  resolveTemplateId,
} from "../providers/gupshup-whatsapp.js";
import { telemetry } from "../telemetry/posthog.js";
import { lookupUsers } from "../user-lookup.js";
import { programOf } from "../db/repos/dispatch-programs.js";
import { SendLogRecorder } from "./send-log-recorder.js";
import { deriveTemplateRef } from "./template-ref.js";
import type { DispatchPayload } from "./types.js";

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

  const program = programOf(payload);
  const sendLogs = new SendLogRecorder({
    dispatch_run_id: dispatchRunId,
    campaign_id,
    program_id: program.program_id,
    step_id: program.step_id,
    organization_id: metadata.organization_id ?? null,
    channel: "whatsapp",
    provider: "gupshup",
    // Unlike email, this is a real provider-registered template id.
    template_ref: deriveTemplateRef(
      payload,
      templateSpec ? resolveTemplateId(templateSpec) : null
    ),
  });

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
      warnUnlessVitest(
        `[Dispatch] User ${userId} has no phone number, skipping WhatsApp send`
      );
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

    const sendStartedAt = performance.now();
    const result = await provider.send(message);
    const latencyMs = Math.round(performance.now() - sendStartedAt);
    if (!result.success) {
      telemetry.capture("dispatcher_provider_send_failed", {
        provider: "gupshup",
        channel: "whatsapp",
      });
    }
    sendLogs.add({
      user_id: userId,
      status: result.success ? "sent" : "failed",
      provider_message_id: result.messageId ?? null,
      latency_ms: latencyMs,
      ...(result.success
        ? {}
        : {
            error_category: "delivery_failure",
            error_message: result.error ?? "provider send failed",
          }),
    });
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

  sendLogs.flush();

  const sent = sendResults.filter((r) => r.success).length;
  const failed = sendResults.filter((r) => !r.success).length;

  logUnlessVitest(
    `[Dispatch] WhatsApp campaign ${campaign_id}: ${sent} sent, ${failed} failed (events emitted via pipeline)`
  );
  telemetry.capture("dispatcher_dispatch_completed", {
    channel: "whatsapp",
    provider: "gupshup",
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

  // A "successful" send with no provider message id can't be correlated to later
  // GatewayAPI delivery receipts (dispatch_message_map is keyed on it), so emit a
  // failed event with an explicit reason instead of an uncorrelatable "dispatched".
  const hasMessageId = typeof messageId === "string" && messageId.length > 0;
  if (success && !hasMessageId) {
    warnUnlessVitest(
      `[Dispatch] WhatsApp send for user=${userId} campaign=${campaign_id} succeeded but returned no provider message id — emitting failed (noProviderMessageId)`
    );
  }
  const effectiveSuccess = success && hasMessageId;
  const effectiveError =
    success && !hasMessageId ? "noProviderMessageId" : error;

  const dispatch_id = payload.dispatch_ids?.[userId];

  // `smsign_<sig>` is the same HMAC placed on the outbound Gupshup `extra`/`tag`.
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
      provider: "gupshup",
      provider_message_id: messageId ?? "unknown",
      occurred_at: new Date().toISOString(),
      metadata: {
        ...(effectiveError ? { bounce_reason: effectiveError } : {}),
        ...(dispatch_id ? { dispatch_id } : {}),
        ...(sign ? { sign } : {}),
      },
    },
  });

  logUnlessVitest(
    `[Dispatch] event emitted user=${userId} event=${effectiveSuccess ? "dispatched" : "failed"} messageId=${messageId ?? "unknown"}`
  );
}
