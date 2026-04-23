import type { SendEmailCommandInput } from "@aws-sdk/client-ses";
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
    console.warn(
      "[SES-Events] SES_EVENT_CONFIG_SET not set — outbound messages will not emit tag-based correlation in SNS. Set SES_EVENT_CONFIG_SET for event tracking."
    );
  }
  const tags = [
    { Name: "campaign_id", Value: ctx.campaign_id.slice(0, 256) },
    { Name: "user_id", Value: ctx.user_id.slice(0, 256) },
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
