import { hasDevSentCampaign, markDevSentCampaign } from "../db/repos/dev-sent.js";
import { emitEvent } from "../events/index.js";
import { registerCampaignCallback } from "../events/campaign-callback-registry.js";
import { resolveAnalyticsCallbackUrl } from "../events/resolve-analytics-callback-url.js";
import { processImages, type ImageMapping } from "../images/handler.js";
import { rewriteImageUrls } from "../images/rewriter.js";
import { componentLogger } from "../logging/logger.js";
import { LogComponent } from "../logging/conventions.js";
import { countFallbacks, personalize, resolvableTokens } from "../personalize.js";
import { getProvider } from "../providers/index.js";
import type { EmailMessage } from "../providers/types.js";
import { telemetry } from "../telemetry/posthog.js";
import { lookupUsers } from "../user-lookup.js";
import { resolveDynamicValues } from "../variables/resolver.js";
import { programOf } from "../db/repos/dispatch-programs.js";
import { SendLogRecorder } from "./send-log-recorder.js";
import { deriveTemplateRef } from "./template-ref.js";
import { ensurePlaceholdersFresh } from "../variables/service.js";
import { processWhatsAppDispatch } from "./whatsapp.js";
import type { DispatchPayload } from "./types.js";

export type { DispatchPayload } from "./types.js";

const log = componentLogger(LogComponent.dispatchEmail);

/** What a completed run reports back so the dispatch_runs row can be finished. */
export type DispatchOutcome = {
  sent: number;
  failed: number;
  /** Variable resolutions attempted: recipients x tokens the template uses. */
  resolution_total?: number;
  resolution_fallbacks?: number;
};

export async function processDispatch(
  payload: DispatchPayload,
  fromEmail: string,
  dispatchRunId?: string
): Promise<DispatchOutcome> {
  // Pick up variable edits made via the admin API since the last dispatch —
  // one refresh per campaign so the whole run uses a consistent set.
  await ensurePlaceholdersFresh();

  if (payload.channel === "whatsapp") {
    return processWhatsAppDispatch(payload, dispatchRunId);
  }

  const { campaign_id, user_ids, content, metadata } = payload;

  log.info(
    { recipients: user_ids.length, channel: "email", has_images: Boolean(payload.images?.length) },
    "Dispatch started"
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

  // Resolve async (query/api) variables once for the whole recipient set, before
  // the sync personalize pass. Sync sources (field/computed/constant) skip this.
  const resolvedVars = await resolveDynamicValues([...users.values()], personalizeCtx);

  // The variables this message actually references — computed once for the run,
  // because the template is the same for every recipient. This is the
  // denominator for the fallback rate; counting the whole registry would inflate
  // it with variables no template mentions.
  const usedTokens = resolvableTokens([
    content.subject,
    content.html_body,
    content.text_body,
  ]);

  let imageMappings: ImageMapping[] = [];
  if (payload.images && payload.images.length > 0) {
    imageMappings = await processImages(payload.images, campaign_id);
  }

  const provider = getProvider();
  const devRecipient = process.env.DEV_RECIPIENT_EMAIL;

  const program = programOf(payload);
  const sendLogs = new SendLogRecorder({
    dispatch_run_id: dispatchRunId,
    campaign_id,
    program_id: program.program_id,
    step_id: program.step_id,
    organization_id: metadata.organization_id ?? null,
    channel: "email",
    provider: provider.name,
    template_ref: deriveTemplateRef(payload),
  });
  /** Per recipient, how many referenced variables fell back. Keyed by user id. */
  const fallbackCounts = new Map<string, number>();
  /** Counted, not derived: DEV mode breaks the loop early, so messages.length lies. */
  let unresolved = 0;

  if (devRecipient && (await hasDevSentCampaign(campaign_id))) {
    log.info(
      { dev_mode: true },
      "Dispatch skipped — DEV_RECIPIENT_EMAIL already received this campaign"
    );
    return { sent: 0, failed: 0 };
  }

  const messages: Array<{ userId: string; message: EmailMessage }> = [];

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

    const resolution = resolvedVars.get(user.user_id);
    const resolved = resolution?.values;
    fallbackCounts.set(
      userId,
      countFallbacks(
        usedTokens,
        user,
        personalizeCtx,
        resolved,
        new Set(resolution?.fallbacks ?? [])
      )
    );

    const subject = content.subject
      ? personalize(content.subject, user, personalizeCtx, resolved)
      : "No Subject";
    let html = content.html_body
      ? personalize(content.html_body, user, personalizeCtx, resolved)
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
          text: personalize(content.text_body, user, personalizeCtx, resolved),
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
      log.warn(
        { dev_mode: true, recipients: user_ids.length },
        "DEV mode — routing the whole campaign to DEV_RECIPIENT_EMAIL, one message only"
      );
      break;
    }
  }

  if (unresolved > 0) {
    // Aggregated on purpose: the per-recipient detail is at debug above, and in
    // dispatch_send_logs with error_category=user_not_found.
    log.warn(
      { provider: provider.name, requested: user_ids.length, unresolved },
      `${unresolved} of ${user_ids.length} recipients could not be resolved`
    );
  }
  log.info(
    { provider: provider.name, count: messages.length, tokens_used: usedTokens.length },
    "Personalization complete — handing messages to the provider"
  );

  const sendResults: Array<{
    userId: string;
    success: boolean;
    messageId?: string;
    error?: string;
  }> = [];
  let failureCount = 0;

  for (const { userId, message } of messages) {
    // Times the provider call alone. dispatch_runs.duration_ms measures the whole
    // request, including lookup and personalization, so it cannot answer
    // "is the provider slow?".
    const sendStartedAt = performance.now();
    const result = await provider.send(message);
    const latencyMs = Math.round(performance.now() - sendStartedAt);

    if (!result.success) {
      telemetry.capture("dispatcher_provider_send_failed", {
        provider: provider.name,
        channel: "email",
      });
      // The first failure carries the provider's reason at warn; the rest go to
      // debug and are summarised by the completion line. A 50,000-recipient run
      // that fails entirely should not write 50,000 warn rows to find that out.
      const level = failureCount === 0 ? "warn" : "debug";
      failureCount += 1;
      log[level](
        {
          user_id: userId,
          provider: provider.name,
          error_category: "delivery_failure",
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
            error_category: "delivery_failure",
            error_message: result.error ?? "provider send failed",
          }),
      fallbacks_used: fallbackCounts.get(userId) ?? 0,
    });
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
    log.debug(
      {
        user_id: userId,
        event: result.success ? "dispatched" : "failed",
        provider_message_id: result.messageId ?? null,
        duration_ms: latencyMs,
      },
      "Send event emitted"
    );
  }

  sendLogs.flush();

  const sent = sendResults.filter((r) => r.success).length;
  const failed = sendResults.filter((r) => !r.success).length;

  const fallbacksUsed = [...fallbackCounts.values()].reduce((a, b) => a + b, 0);
  // Completion is the line an operator finds first, so it carries the whole
  // shape of the run: what was asked for, what happened, and how personalized
  // it actually was.
  log[failed > 0 ? "warn" : "info"](
    {
      provider: provider.name,
      channel: "email",
      requested: user_ids.length,
      sent,
      failed,
      unresolved,
      fallbacks_used: fallbacksUsed,
      resolutions_total: messages.length * usedTokens.length,
    },
    `Dispatch completed — ${sent} sent, ${failed} failed`
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
  return {
    sent,
    failed,
    // Only recipients that produced a message were resolved at all — a
    // user_not_found recipient never reached personalize().
    resolution_total: messages.length * usedTokens.length,
    resolution_fallbacks: fallbacksUsed,
  };
}
