import type { SendEmailCommandInput } from "@aws-sdk/client-ses";
import { componentLogger } from "../../logging/logger.js";
import { LogComponent } from "../../logging/conventions.js";
import type { SendContext } from "../../providers/types.js";

let warnedMissingConfigSet = false;

/**
 * SES message tags (≤256 chars per value) — echo in SNS event `mail.tags`.
 * Full `analytics_callback_url` does not fit; use {@link registerCampaignCallback} at dispatch time.
 */
export function applySesMessageTags(
  input: SendEmailCommandInput,
  ctx: SendContext
): SendEmailCommandInput {
  const configurationSetName =
    process.env.SES_EVENT_CONFIG_SET || process.env.SES_CONFIGURATION_SET || undefined;
  if (!configurationSetName && !warnedMissingConfigSet) {
    warnedMissingConfigSet = true;
    componentLogger(LogComponent.events).warn(
      { provider: "ses", error_category: "missing_config" },
      "SES_EVENT_CONFIG_SET is not set — outbound messages carry no tags, so SNS " +
        "delivery and open events cannot be correlated back to a campaign"
    );
  }
  const tags = [
    { Name: "campaign_id", Value: ctx.campaign_id.slice(0, 256) },
    { Name: "user_id", Value: ctx.user_id.slice(0, 256) },
    ...(ctx.dispatch_id
      ? [{ Name: "dispatch_id", Value: ctx.dispatch_id.slice(0, 256) }]
      : []),
    { Name: "organization_id", Value: ctx.organization_id.slice(0, 256) },
  ];
  return {
    ...input,
    ...(configurationSetName ? { ConfigurationSetName: configurationSetName } : {}),
    Tags: [...(input.Tags ?? []), ...tags],
  };
}

export function resetSesTaggerWarningsForTests(): void {
  warnedMissingConfigSet = false;
}
