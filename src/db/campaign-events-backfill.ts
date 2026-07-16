/**
 * One-shot startup backfill: copies the StandardizedEvent envelopes still
 * sitting in event_outbox into campaign_events, so deployments that predate
 * the console see their surviving history immediately. Idempotent twice over:
 * a dispatcher_meta flag skips the whole pass, and dedupe_key insert-ignore
 * makes a crashed/re-run pass safe.
 */

import { and, asc, eq, gt, or } from "drizzle-orm";
import type { StandardizedEvent } from "../events/common/types.js";
import { campaignEventRowFromStandardized } from "../events/persist.js";
import { componentLogger } from "../logging/logger.js";
import { isDbInitialized, getDb } from "./client.js";
import { queryDb, tableFor } from "./dialect-helpers.js";
import { insertCampaignEvents } from "./repos/campaign-events.js";
import { resolveProgram } from "./repos/dispatch-programs.js";
import { getMeta, setMeta } from "./repos/meta.js";
import { META_KEYS, type OutboxRow } from "./schema/index.js";

const log = componentLogger("db");
const BATCH = 500;

export async function backfillCampaignEventsOnce(): Promise<{ copied: number }> {
  if (!isDbInitialized()) return { copied: 0 };
  if (await getMeta(META_KEYS.campaignEventsBackfillDoneAt)) return { copied: 0 };

  const dbx = getDb();
  const outbox = tableFor(dbx, "eventOutbox");
  let copied = 0;
  let cursor: { ts: Date; id: string } | null = null;

  for (;;) {
    const conditions =
      cursor === null
        ? undefined
        : or(
            gt(outbox.created_at, cursor.ts),
            and(eq(outbox.created_at, cursor.ts), gt(outbox.id, cursor.id))
          );
    let builder = queryDb(dbx).select().from(outbox);
    if (conditions) builder = builder.where(conditions);
    const raw: Record<string, unknown>[] = await builder
      .orderBy(asc(outbox.created_at), asc(outbox.id))
      .limit(BATCH);
    if (raw.length === 0) break;

    const outboxRows = (raw as unknown as OutboxRow[]).filter((row) => {
      const event = row.event as unknown as StandardizedEvent;
      return Boolean(event && event.campaign_id && event.user_id && event.event);
    });
    // Historical sends resolve through the same program map as live ones.
    const programs = await resolveProgram(
      outboxRows.map((row) => (row.event as unknown as StandardizedEvent).campaign_id)
    );
    const rows = outboxRows.map((row) => {
      const event = row.event as unknown as StandardizedEvent;
      // received_at = the outbox enqueue time, for historical fidelity.
      return campaignEventRowFromStandardized(
        event,
        row.created_at,
        programs.get(event.campaign_id) ?? {
          program_id: event.campaign_id,
          program_kind: "campaign",
          step_id: null,
        }
      );
    });
    await insertCampaignEvents(rows);
    copied += rows.length;

    const last = raw[raw.length - 1] as unknown as OutboxRow;
    cursor = { ts: last.created_at, id: last.id };
    if (raw.length < BATCH) break;
  }

  await setMeta(META_KEYS.campaignEventsBackfillDoneAt, new Date().toISOString());
  if (copied > 0) {
    log.info(`[DB] Backfilled ${copied} campaign event(s) from the outbox into the console store`);
  }
  return { copied };
}
