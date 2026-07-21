import { eq } from "drizzle-orm";
import { getDb } from "../client.js";
import { queryDb, tableFor, upsert } from "../dialect-helpers.js";

/** DEV_RECIPIENT_EMAIL de-dupe — now restart-proof. */
export async function hasDevSentCampaign(campaignId: string): Promise<boolean> {
  const dbx = getDb();
  const table = tableFor(dbx, "devSentCampaigns");
  const rows: unknown[] = await queryDb(dbx)
    .select({ campaign_id: table.campaign_id })
    .from(table)
    .where(eq(table.campaign_id, campaignId));
  return rows.length > 0;
}

export async function markDevSentCampaign(campaignId: string): Promise<void> {
  const now = new Date();
  await upsert(
    getDb(),
    "devSentCampaigns",
    { campaign_id: campaignId, sent_at: now },
    ["campaign_id"],
    { sent_at: now }
  );
}
