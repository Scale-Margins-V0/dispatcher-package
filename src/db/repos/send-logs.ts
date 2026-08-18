/**
 * Per-recipient send log — one row per recipient per send, success or failure.
 *
 * This is the highest-volume table in the state DB: a 50,000-recipient campaign
 * writes 50,000 rows. Two consequences shape this file:
 *
 *   - inserts are chunked, mirroring insertCampaignEvents, so a large batch
 *     never becomes one enormous statement;
 *   - every read is bounded and ordered on the (program_id, occurred_at) index.
 *
 * Two paging styles, deliberately: listSendLogs() is keyset-paged for anything
 * that walks the table, listSendLogsPage() is offset-paged for the API, whose
 * page/limit contract an operator drives by hand.
 */

import { and, count, desc, eq, lt, or } from "drizzle-orm";
import { getDb } from "../client.js";
import { queryDb, tableFor } from "../dialect-helpers.js";
import type { SendLogRow } from "../schema/index.js";

/** Matches campaign-events.ts — small enough for every dialect's parameter limit. */
const INSERT_CHUNK = 200;

export async function insertSendLogs(rows: SendLogRow[]): Promise<void> {
  if (rows.length === 0) return;
  const dbx = getDb();
  const table = tableFor(dbx, "dispatchSendLogs");
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await queryDb(dbx).insert(table).values(rows.slice(i, i + INSERT_CHUNK));
  }
}

export async function getSendLogsForRun(
  dispatchRunId: string,
  limit = 500
): Promise<SendLogRow[]> {
  const dbx = getDb();
  const table = tableFor(dbx, "dispatchSendLogs");
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .select()
    .from(table)
    .where(eq(table.dispatch_run_id, dispatchRunId))
    .orderBy(desc(table.occurred_at), desc(table.id))
    .limit(limit);
  return rows as unknown as SendLogRow[];
}

export type SendLogFilters = {
  program_id?: string;
  campaign_id?: string;
  dispatch_run_id?: string;
  user_id?: string;
  status?: SendLogRow["status"];
};

export type SendLogQuery = SendLogFilters & {
  cursor?: { ts: Date; id: string };
  limit: number;
};

/** Shared WHERE, so the count and the page can never disagree about the filter. */
function filterConditions(table: any, filters: SendLogFilters): unknown[] {
  const conditions: unknown[] = [];
  if (filters.program_id) conditions.push(eq(table.program_id, filters.program_id));
  if (filters.campaign_id) conditions.push(eq(table.campaign_id, filters.campaign_id));
  if (filters.dispatch_run_id) {
    conditions.push(eq(table.dispatch_run_id, filters.dispatch_run_id));
  }
  if (filters.user_id) conditions.push(eq(table.user_id, filters.user_id));
  if (filters.status) conditions.push(eq(table.status, filters.status));
  return conditions;
}

export async function countSendLogs(filters: SendLogFilters): Promise<number> {
  const dbx = getDb();
  const table = tableFor(dbx, "dispatchSendLogs");
  const conditions = filterConditions(table, filters);
  let builder = queryDb(dbx).select({ total: count().as("total") }).from(table);
  if (conditions.length > 0) builder = builder.where(and(...(conditions as never[])));
  const [row]: Array<{ total: unknown }> = await builder;
  return Number(row?.total) || 0;
}

/**
 * One offset page, newest first.
 *
 * ponytail: OFFSET, not a keyset cursor. `limit` is capped at 100 by the API and
 * an operator paging by hand never gets deep enough for it to matter. Switch to
 * listSendLogs()'s cursor if something ever walks the whole table.
 */
export async function listSendLogsPage(
  filters: SendLogFilters,
  page: { offset: number; limit: number }
): Promise<SendLogRow[]> {
  const dbx = getDb();
  const table = tableFor(dbx, "dispatchSendLogs");
  const conditions = filterConditions(table, filters);
  let builder = queryDb(dbx).select().from(table);
  if (conditions.length > 0) builder = builder.where(and(...(conditions as never[])));
  const rows: Record<string, unknown>[] = await builder
    .orderBy(desc(table.occurred_at), desc(table.id))
    .limit(page.limit)
    .offset(page.offset);
  return rows as unknown as SendLogRow[];
}

export type SendLogPage = {
  logs: SendLogRow[];
  next_cursor: { ts: Date; id: string } | null;
};

export async function listSendLogs(options: SendLogQuery): Promise<SendLogPage> {
  const dbx = getDb();
  const table = tableFor(dbx, "dispatchSendLogs");
  const conditions = filterConditions(table, options);
  if (options.cursor) {
    // Drizzle operators, not raw sql`` — raw templates don't run Date params
    // through the column encoder, which breaks on sqlite (ms-integer storage).
    conditions.push(
      or(
        lt(table.occurred_at, options.cursor.ts),
        and(eq(table.occurred_at, options.cursor.ts), lt(table.id, options.cursor.id))
      )
    );
  }

  let builder = queryDb(dbx).select().from(table);
  if (conditions.length > 0) builder = builder.where(and(...(conditions as never[])));
  // Fetch one extra to learn whether another page exists, without a count query.
  const raw: Record<string, unknown>[] = await builder
    .orderBy(desc(table.occurred_at), desc(table.id))
    .limit(options.limit + 1);

  const rows = raw as unknown as SendLogRow[];
  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  const last = page[page.length - 1];
  return {
    logs: page,
    next_cursor: hasMore && last ? { ts: last.occurred_at, id: last.id } : null,
  };
}
