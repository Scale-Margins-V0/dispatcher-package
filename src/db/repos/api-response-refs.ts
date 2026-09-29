/**
 * Values saved from API variable responses, keyed by the message they were
 * sent with (see apiResponseRefs in the schema). Written once per dispatch by
 * ResponseRefRecorder; pruned by the retention sweep on message_id_ttl.
 */

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../client.js";
import { queryDb, tableFor } from "../dialect-helpers.js";
import type { ApiResponseRefRow } from "../schema/index.js";

/** Matches provider-message-ids.ts — safe for every dialect's parameter limit. */
const INSERT_CHUNK = 200;

export async function insertApiResponseRefs(rows: ApiResponseRefRow[]): Promise<void> {
  if (rows.length === 0) return;
  const dbx = getDb();
  const table = tableFor(dbx, "apiResponseRefs");
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await queryDb(dbx).insert(table).values(rows.slice(i, i + INSERT_CHUNK));
  }
}

/** A sent message as the client-events endpoint needs it: its id and recipient. */
export type SentMessage = { provider_message_id: string; user_id: string };

/** Sent messages of `provider` with these ids (provider_message_ids). */
export async function findSentMessages(provider: string, providerMessageIds: string[]): Promise<SentMessage[]> {
  if (providerMessageIds.length === 0) return [];
  const dbx = getDb();
  const t = tableFor(dbx, "providerMessageIds");
  return (await queryDb(dbx)
    .select({ provider_message_id: t.provider_message_id, user_id: t.user_id })
    .from(t)
    .where(and(eq(t.provider, provider), inArray(t.provider_message_id, providerMessageIds)))) as SentMessage[];
}

export type RefMatch = {
  provider: string;
  variable_name: string;
  path: string;
  value: string;
  user_id?: string;
  campaign_id?: string;
  organization_id?: string;
  dispatch_id?: string;
};

/**
 * The distinct messages a saved value was sent with, narrowed by whichever of
 * user / campaign / organization / dispatch the caller knows. At most `limit`
 * — two is enough to tell "exactly one" from "ambiguous".
 */
export async function findMessagesBySavedValue(match: RefMatch, limit = 2): Promise<SentMessage[]> {
  const dbx = getDb();
  const t = tableFor(dbx, "apiResponseRefs");
  const where = [
    eq(t.provider, match.provider),
    eq(t.variable_name, match.variable_name),
    eq(t.path, match.path),
    eq(t.value, match.value),
    ...(match.user_id ? [eq(t.user_id, match.user_id)] : []),
    ...(match.campaign_id ? [eq(t.campaign_id, match.campaign_id)] : []),
    ...(match.organization_id ? [eq(t.organization_id, match.organization_id)] : []),
    ...(match.dispatch_id ? [eq(t.dispatch_id, match.dispatch_id)] : []),
  ];
  return (await queryDb(dbx)
    .selectDistinct({ provider_message_id: t.provider_message_id, user_id: t.user_id })
    .from(t)
    .where(and(...where))
    .limit(limit)) as SentMessage[];
}
