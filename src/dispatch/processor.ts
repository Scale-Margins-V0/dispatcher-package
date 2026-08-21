import { hasDevSentCampaign, markDevSentCampaign } from "../db/repos/dev-sent.js";
import { emitEvent } from "../events/index.js";
import { registerCampaignCallback } from "../events/campaign-callback-registry.js";
import { resolveAnalyticsCallbackUrl } from "../events/resolve-analytics-callback-url.js";
import { processImages, type ImageMapping } from "../images/handler.js";
import { rewriteImageUrls } from "../images/rewriter.js";
import { componentLogger } from "../logging/logger.js";
import { LogComponent } from "../logging/conventions.js";
import { countFallbacks, personalize, resolvableTokens } from "../personalize.js";
import {
  resolveSenderChainForRecipient,
  sendWithFailover,
} from "../providers/senders.js";
import type { EmailMessage, Sender } from "../providers/types.js";
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

  const devRecipient = process.env.DEV_RECIPIENT_EMAIL;

  const program = programOf(payload);
  const sendLogs = new SendLogRecorder({
    dispatch_run_id: dispatchRunId,
    campaign_id,
    program_id: program.program_id,
    step_id: program.step_id,
    organization_id: metadata.organization_id ?? null,
    channel: "email",
    provider: metadata.sender_id || "multi",
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

  const messages: Array<{ userId: string; message: EmailMessage; chain: Sender[] }> = [];

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

    const chain = resolveSenderChainForRecipient(
      userId,
      "email",
      metadata.organization_id,
      {
        sender_id: metadata.sender_id,
        from_email: metadata.from_email,
        sender_strict: metadata.sender_strict,
      }
    );

    if (chain.length === 0) {
      unresolved += 1;
      log.warn(
        { user_id: userId, organization_id: metadata.organization_id },
        "No enabled sender found for organization on email channel"
      );
      sendLogs.add({
        user_id: userId,
        status: "failed",
        error_category: "no_sender_for_organization",
        error_message: `No sender configured for org ${metadata.organization_id}`,
      });
      await emitEvent({
        callbackUrl: resolvedAnalyticsUrl,
        event: {
          campaign_id,
          user_id: userId,
          organization_id: metadata.organization_id,
          analytics_callback_url: resolvedAnalyticsUrl,
          channel: "email",
          event: "failed",
          provider: "ses",
          provider_message_id: "unknown",
          occurred_at: new Date().toISOString(),
          metadata: {
            bounce_reason: "no_sender_for_organization",
            ...(payload.dispatch_ids?.[userId]
              ? { dispatch_id: payload.dispatch_ids[userId] }
              : {}),
          },
        },
      });
      continue;
    }

    messages.push({
      userId,
      chain,
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
    log.warn(
      { requested: user_ids.length, unresolved },
      `${unresolved} of ${user_ids.length} recipients could not be resolved or had no sender`
    );
  }
  log.info(
    { count: messages.length, tokens_used: usedTokens.length },
    "Personalization complete — handing messages to the provider"
  );

  const sendResults: Array<{
    userId: string;
    success: boolean;
    senderId: string;
    provider: string;
    messageId?: string;
    error?: string;
  }> = [];
  let failureCount = 0;

  for (const { userId, message, chain } of messages) {
    const sendStartedAt = performance.now();
    const result = await sendWithFailover(message, chain, "email");
    const latencyMs = Math.round(performance.now() - sendStartedAt);

    if (!result.success) {
      telemetry.capture("dispatcher_provider_send_failed", {
        provider: result.finalSender.config.provider,
        channel: "email",
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
          attempts: result.attempts.length,
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
      fallbacks_used:
        (fallbackCounts.get(userId) ?? 0) +
        (result.attempts.length > 1 ? result.attempts.length - 1 : 0),
    });

    sendResults.push({
      userId,
      success: result.success,
      senderId: result.finalSender.config.id,
      provider: result.finalSender.config.provider,
      messageId: result.messageId,
      error: result.error,
    });

    await emitEvent({
      callbackUrl: resolvedAnalyticsUrl,
      event: {
        campaign_id,
        user_id: userId,
        organization_id: metadata.organization_id,
        analytics_callback_url: resolvedAnalyticsUrl,
        channel: "email",
        event: result.success ? "dispatched" : "failed",
        provider: result.finalSender.config.provider,
        provider_message_id: result.messageId ?? "unknown",
        occurred_at: new Date().toISOString(),
        metadata: {
          ...(result.error ? { bounce_reason: result.error } : {}),
          sender_id: result.finalSender.config.id,
          attempts: result.attempts.length,
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
        sender_id: result.finalSender.config.id,
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
  log[failed > 0 ? "warn" : "info"](
    {
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
    requested_count: user_ids.length,
    resolved_count: messages.length,
    sent_count: sent,
    failed_count: failed,
    image_count: payload.images?.length ?? 0,
  });
  return {
    sent,
    failed,
    resolution_total: messages.length * usedTokens.length,
    resolution_fallbacks: fallbacksUsed,
  };
}
