/**
 * Resolve ScaleMargin analytics POST URL for an inbound provider event.
 *
 * Default priority: correlation from provider (e.g. SendGrid custom_args) →
 * in-memory dispatch registry → {@link SCALEMARGIN_ANALYTICS_CALLBACK_URL} when registry is cold.
 *
 * When {@link SCALEMARGIN_ANALYTICS_CALLBACK_URL_OVERRIDES_DISPATCH} is set, the env URL wins over
 * dispatch payload / correlation (local clara-client + hosted Atlas sending a prod callback URL).
 */

import { getCampaignCallback } from "./campaign-callback-registry.js";
import { validateCallbackUrl } from "./forwarder.js";

export const SCALEMARGIN_ANALYTICS_CALLBACK_URL_ENV =
  "SCALEMARGIN_ANALYTICS_CALLBACK_URL";

/** When truthy, {@link SCALEMARGIN_ANALYTICS_CALLBACK_URL} replaces payload/correlation URLs. */
export const SCALEMARGIN_ANALYTICS_CALLBACK_URL_OVERRIDES_DISPATCH_ENV =
  "SCALEMARGIN_ANALYTICS_CALLBACK_URL_OVERRIDES_DISPATCH";

function trimUrl(raw: string | undefined): string | undefined {
  const t = raw?.trim();
  return t || undefined;
}

function envOverridesDispatch(): boolean {
  const v =
    process.env[SCALEMARGIN_ANALYTICS_CALLBACK_URL_OVERRIDES_DISPATCH_ENV]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function resolveAnalyticsCallbackUrl(params: {
  campaignId: string;
  correlationCallbackUrl?: string;
}): string | undefined {
  const fromEnv = trimUrl(process.env[SCALEMARGIN_ANALYTICS_CALLBACK_URL_ENV]);
  if (
    envOverridesDispatch() &&
    fromEnv &&
    validateCallbackUrl(fromEnv)
  ) {
    return fromEnv;
  }

  const fromCorrelation = trimUrl(params.correlationCallbackUrl);
  if (fromCorrelation) {
    return fromCorrelation;
  }

  const reg = getCampaignCallback(params.campaignId);
  const fromRegistry = trimUrl(reg?.analytics_callback_url);
  if (fromRegistry) {
    return fromRegistry;
  }

  if (fromEnv && validateCallbackUrl(fromEnv)) {
    return fromEnv;
  }

  return undefined;
}
