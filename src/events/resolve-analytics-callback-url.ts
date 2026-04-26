/**
 * Resolve ScaleMargin analytics POST URL for an inbound provider event.
 * Priority: correlation from provider (e.g. SendGrid custom_args) →
 * in-memory dispatch registry (SES immediately after send) →
 * {@link SCALEMARGIN_ANALYTICS_CALLBACK_URL} when registry is cold (e.g. delayed SES after restart).
 */

import { getCampaignCallback } from "./campaign-callback-registry.js";
import { validateCallbackUrl } from "./forwarder.js";

export const SCALEMARGIN_ANALYTICS_CALLBACK_URL_ENV =
  "SCALEMARGIN_ANALYTICS_CALLBACK_URL";

function trimUrl(raw: string | undefined): string | undefined {
  const t = raw?.trim();
  return t || undefined;
}

export function resolveAnalyticsCallbackUrl(params: {
  campaignId: string;
  correlationCallbackUrl?: string;
}): string | undefined {
  const fromCorrelation = trimUrl(params.correlationCallbackUrl);
  if (fromCorrelation) {
    return fromCorrelation;
  }

  const reg = getCampaignCallback(params.campaignId);
  const fromRegistry = trimUrl(reg?.analytics_callback_url);
  if (fromRegistry) {
    return fromRegistry;
  }

  const fromEnv = trimUrl(process.env[SCALEMARGIN_ANALYTICS_CALLBACK_URL_ENV]);
  if (fromEnv && validateCallbackUrl(fromEnv)) {
    return fromEnv;
  }

  return undefined;
}
