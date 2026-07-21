/**
 * Registry: campaign_id → ScaleMargin analytics callback URL.
 * Required for SES (message tag values max 256 chars — full callback URL does not fit in tags).
 * SendGrid echoes full URL in custom_args so this registry is optional for that path.
 *
 * Backed by the campaign_callbacks table with an in-memory hot cache, so a pod
 * restart mid-campaign no longer breaks SES event correlation. Registration
 * stays sync (write-through, fire-and-forget); lookups miss to the DB.
 */

import { isDbInitialized } from "../db/client.js";
import {
  getCampaignCallbackRow,
  listRecentCampaignCallbacks,
  touchCampaignCallback,
  upsertCampaignCallback,
} from "../db/repos/campaign-callbacks.js";
import { componentLogger } from "../logging/logger.js";

const log = componentLogger("events.callback-registry");

type CallbackEntry = { organization_id: string; analytics_callback_url: string };

const store = new Map<string, CallbackEntry>();

export function registerCampaignCallback(
  campaignId: string,
  organizationId: string,
  analyticsCallbackUrl: string
): void {
  store.set(campaignId, {
    organization_id: organizationId,
    analytics_callback_url: analyticsCallbackUrl,
  });
  if (isDbInitialized()) {
    void upsertCampaignCallback(campaignId, organizationId, analyticsCallbackUrl).catch(
      (error) =>
        log.warn(
          { err: error instanceof Error ? error : new Error(String(error)) },
          `Failed to persist campaign callback for ${campaignId}`
        )
    );
  }
}

/** Sync cache-only lookup (kept for cheap hot-path checks). */
export function getCampaignCallback(campaignId: string): CallbackEntry | undefined {
  return store.get(campaignId);
}

/** Cache lookup with DB read-through — survives restarts mid-campaign. */
export async function getCampaignCallbackDurable(
  campaignId: string
): Promise<CallbackEntry | undefined> {
  const cached = store.get(campaignId);
  if (cached) return cached;
  if (!isDbInitialized()) return undefined;
  try {
    const row = await getCampaignCallbackRow(campaignId);
    if (!row) return undefined;
    const entry: CallbackEntry = {
      organization_id: row.organization_id,
      analytics_callback_url: row.analytics_callback_url,
    };
    store.set(campaignId, entry);
    void touchCampaignCallback(campaignId).catch(() => {});
    return entry;
  } catch (error) {
    log.warn(
      { err: error instanceof Error ? error : new Error(String(error)) },
      `Campaign callback DB lookup failed for ${campaignId}`
    );
    return undefined;
  }
}

/** Boot-time warm load of recent campaigns into the cache. */
export async function warmCampaignCallbackCache(days = 30): Promise<number> {
  if (!isDbInitialized()) return 0;
  const rows = await listRecentCampaignCallbacks(days);
  for (const row of rows) {
    if (!store.has(row.campaign_id)) {
      store.set(row.campaign_id, {
        organization_id: row.organization_id,
        analytics_callback_url: row.analytics_callback_url,
      });
    }
  }
  return rows.length;
}

/** Vitest / integration tests */
export function resetCampaignCallbackRegistryForTests(): void {
  store.clear();
}
