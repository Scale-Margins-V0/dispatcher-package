import { desc, eq, gte } from "drizzle-orm";
import { getDb } from "../client.js";
import { queryDb, tableFor, upsert } from "../dialect-helpers.js";
import type { CampaignCallbackRow } from "../schema/index.js";

export async function upsertCampaignCallback(
  campaignId: string,
  organizationId: string,
  analyticsCallbackUrl: string
): Promise<void> {
  const now = new Date();
  await upsert(
    getDb(),
    "campaignCallbacks",
    {
      campaign_id: campaignId,
      organization_id: organizationId,
      analytics_callback_url: analyticsCallbackUrl,
      created_at: now,
      last_used_at: now,
    },
    ["campaign_id"],
    {
      organization_id: organizationId,
      analytics_callback_url: analyticsCallbackUrl,
      last_used_at: now,
    }
  );
}

export async function getCampaignCallbackRow(
  campaignId: string
): Promise<CampaignCallbackRow | null> {
  const dbx = getDb();
  const table = tableFor(dbx, "campaignCallbacks");
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .select()
    .from(table)
    .where(eq(table.campaign_id, campaignId));
  return (rows[0] as unknown as CampaignCallbackRow) ?? null;
}

export async function touchCampaignCallback(campaignId: string): Promise<void> {
  const dbx = getDb();
  const table = tableFor(dbx, "campaignCallbacks");
  await queryDb(dbx)
    .update(table)
    .set({ last_used_at: new Date() })
    .where(eq(table.campaign_id, campaignId));
}

/** Recent rows for the boot-time warm load of the in-memory map. */
export async function listRecentCampaignCallbacks(
  days: number,
  limit = 5_000
): Promise<CampaignCallbackRow[]> {
  const dbx = getDb();
  const table = tableFor(dbx, "campaignCallbacks");
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .select()
    .from(table)
    .where(gte(table.last_used_at, since))
    .orderBy(desc(table.last_used_at))
    .limit(limit);
  return rows as unknown as CampaignCallbackRow[];
}
