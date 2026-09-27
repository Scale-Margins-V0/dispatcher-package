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

import { and, asc, eq, inArray, isNotNull, lt, lte } from "drizzle-orm";
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

/*
 * Delivery-status polling (src/events/freshchat/status-poller.ts). The rows
 * above double as the poller's work queue: `next_poll_at` set = still polled.
 */


export type PollRow = Pick<
  ProviderMessageIdRow,
  "id" | "provider_message_id" | "user_id" | "sent_at" | "sender_id" | "status" | "status_event" | "poll_attempts"
>;

/** Rows of these senders whose next poll is due, oldest-due first. */
export async function listDuePolls(
  provider: string,
  senderIds: string[],
  now: Date,
  limit: number
): Promise<PollRow[]> {
  if (senderIds.length === 0) return [];
  const dbx = getDb();
  const t = tableFor(dbx, "providerMessageIds");
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .select({
      id: t.id,
      provider_message_id: t.provider_message_id,
      user_id: t.user_id,
      sent_at: t.sent_at,
      sender_id: t.sender_id,
      status: t.status,
      status_event: t.status_event,
      poll_attempts: t.poll_attempts,
    })
    .from(t)
    .where(and(eq(t.provider, provider), inArray(t.sender_id, senderIds), lte(t.next_poll_at, now)))
    .orderBy(asc(t.next_poll_at))
    .limit(limit);
  return rows as unknown as PollRow[];
}

/** Stop polling anything sent before `sentBefore` that never reached a final status. */
export async function expirePolls(provider: string, sentBefore: Date): Promise<void> {
  const dbx = getDb();
  const t = tableFor(dbx, "providerMessageIds");
  await queryDb(dbx)
    .update(t)
    .set({ next_poll_at: null, poll_error: "freshchat_status_poll_ttl reached" })
    .where(and(eq(t.provider, provider), isNotNull(t.next_poll_at), lt(t.sent_at, sentBefore)));
}

export type PollPatch = Partial<
  Pick<
    ProviderMessageIdRow,
    "status" | "status_event" | "status_at" | "provider_ref" | "next_poll_at" | "last_polled_at" | "poll_attempts" | "poll_error"
  >
>;

export async function updatePoll(id: string, patch: PollPatch): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  const dbx = getDb();
  const t = tableFor(dbx, "providerMessageIds");
  await queryDb(dbx).update(t).set(patch).where(eq(t.id, id));
}

/** Rows by provider message id — to fold webhook-reported statuses into the poll state. */
export async function findByProviderMessageIds(
  provider: string,
  providerMessageIds: string[]
): Promise<Array<Pick<ProviderMessageIdRow, "id" | "provider_message_id" | "status_event">>> {
  if (providerMessageIds.length === 0) return [];
  const dbx = getDb();
  const t = tableFor(dbx, "providerMessageIds");
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .select({ id: t.id, provider_message_id: t.provider_message_id, status_event: t.status_event })
    .from(t)
    .where(and(eq(t.provider, provider), inArray(t.provider_message_id, providerMessageIds)));
  return rows as never;
}
