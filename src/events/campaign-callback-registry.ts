/**
 * In-memory registry: campaign_id → ScaleMargin analytics callback URL.
 * Required for SES (message tag values max 256 chars — full callback URL does not fit in tags).
 * SendGrid echoes full URL in custom_args so this registry is optional for that path.
 */

const store = new Map<
  string,
  { organization_id: string; analytics_callback_url: string }
>();

export function registerCampaignCallback(
  campaignId: string,
  organizationId: string,
  analyticsCallbackUrl: string
): void {
  store.set(campaignId, {
    organization_id: organizationId,
    analytics_callback_url: analyticsCallbackUrl,
  });
}

export function getCampaignCallback(campaignId: string):
  | { organization_id: string; analytics_callback_url: string }
  | undefined {
  return store.get(campaignId);
}

/** Vitest / integration tests */
export function resetCampaignCallbackRegistryForTests(): void {
  store.clear();
}
