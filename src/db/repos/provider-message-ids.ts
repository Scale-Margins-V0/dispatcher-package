/**
 * Provider message ids, saved so the company running the dispatcher can query
 * them straight out of the state database.
 *
 * The dispatcher does not read this table. It writes ids and prunes them; the
 * operator does the rest with their own SQL. That is the whole feature, and it
 * is why there is no list/get/paginate surface here — adding one would be
 * inventing an API nobody asked for.
 *
 * Volume matches dispatch_send_logs — one row per accepted send — so inserts
 * are chunked exactly as insertSendLogs does.
 */

import { getDb } from "../client.js";
import { queryDb, tableFor } from "../dialect-helpers.js";
import type { ProviderMessageIdRow } from "../schema/index.js";

/** Matches send-logs.ts and campaign-events.ts — safe for every dialect's parameter limit. */
const INSERT_CHUNK = 200;

export async function insertProviderMessageIds(
  rows: ProviderMessageIdRow[]
): Promise<void> {
  if (rows.length === 0) return;
  const dbx = getDb();
  const table = tableFor(dbx, "providerMessageIds");
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await queryDb(dbx).insert(table).values(rows.slice(i, i + INSERT_CHUNK));
  }
}
