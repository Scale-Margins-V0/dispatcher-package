/**
 * In-memory registry: campaign_id → ScaleMargin analytics callback URL.
 * Required for SES (message tag values max 256 chars — full callback URL does not fit in tags).
 * SendGrid echoes full URL in custom_args so this registry is optional for that path.
 *
 * Persisted to disk so late-arriving events (e.g. unsubscribe link clicks days after dispatch)
 * still resolve even after clara-client restarts.
 */

import fs from "node:fs";
import path from "node:path";

type RegistryEntry = { organization_id: string; analytics_callback_url: string };

const store = new Map<string, RegistryEntry>();

function registryPath(): string {
  return (
    process.env.CAMPAIGN_REGISTRY_PATH?.trim() ||
    path.join(process.cwd(), "data", "campaign-registry.json")
  );
}

function loadFromDisk(): void {
  const p = registryPath();
  try {
    if (!fs.existsSync(p)) return;
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, RegistryEntry>;
    for (const [k, v] of Object.entries(parsed)) {
      if (k && v?.analytics_callback_url && v?.organization_id) {
        store.set(k, v);
      }
    }
  } catch {
    // corrupt or missing file — start fresh, will be overwritten on next dispatch
  }
}

function saveToDisk(): void {
  const p = registryPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const obj: Record<string, RegistryEntry> = {};
    for (const [k, v] of store.entries()) obj[k] = v;
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf-8");
  } catch {
    // non-fatal — in-memory registry still works for warm dispatches
  }
}

// Load persisted registry at module init
loadFromDisk();

export function registerCampaignCallback(
  campaignId: string,
  organizationId: string,
  analyticsCallbackUrl: string
): void {
  store.set(campaignId, {
    organization_id: organizationId,
    analytics_callback_url: analyticsCallbackUrl,
  });
  saveToDisk();
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
