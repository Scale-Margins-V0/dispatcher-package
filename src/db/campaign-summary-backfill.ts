/**
 * One-shot startup pass that builds campaign_summary rows for campaigns that
 * ran before the table existed.
 *
 * Without it a dispatcher upgrading into this feature shows an empty campaign
 * list until its next send, even though dispatch_runs and campaign_events are
 * full of history.
 *
 * Idempotent twice over: a dispatcher_meta flag short-circuits the whole pass,
 * and refreshCampaignSummary is itself a recompute, so a crashed run that is
 * retried produces the same rows rather than double-counting.
 */

import { componentLogger } from "../logging/logger.js";
import { isDbInitialized } from "./client.js";
import { getMeta, setMeta } from "./repos/meta.js";
import { rebuildAllCampaignSummaries } from "./repos/campaign-summary.js";
import { META_KEYS } from "./schema/index.js";

const log = componentLogger("db.campaign-summary");

export async function backfillCampaignSummariesOnce(): Promise<{ rebuilt: number }> {
  if (!isDbInitialized()) return { rebuilt: 0 };
  if (await getMeta(META_KEYS.campaignSummaryBackfillDoneAt)) return { rebuilt: 0 };

  try {
    const { rebuilt } = await rebuildAllCampaignSummaries();
    await setMeta(META_KEYS.campaignSummaryBackfillDoneAt, new Date().toISOString());
    if (rebuilt > 0) {
      log.info(`[Campaigns] Backfilled ${rebuilt} campaign summar${rebuilt === 1 ? "y" : "ies"}`);
    }
    return { rebuilt };
  } catch (error) {
    // Deliberately not flagged as done: boot continues, and the next restart
    // retries. Live campaigns still get their rollup from the normal refresh
    // path, so a failed backfill degrades history, never correctness.
    log.warn(
      { err: error instanceof Error ? error : new Error(String(error)) },
      "[Campaigns] Summary backfill failed — will retry on next start"
    );
    return { rebuilt: 0 };
  }
}
