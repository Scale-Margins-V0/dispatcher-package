import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { getDb } from "../client.js";
import { queryDb, tableFor } from "../dialect-helpers.js";
import type { OutboxRow } from "../schema/index.js";

export type NewOutboxEvent = {
  callback_url: string;
  campaign_id: string;
  organization_id: string;
  event: Record<string, unknown>;
  idempotency_key: string;
};

export async function enqueueOutbox(events: NewOutboxEvent[]): Promise<void> {
  if (events.length === 0) return;
  const dbx = getDb();
  const now = new Date();
  const rows: OutboxRow[] = events.map((event) => ({
    id: crypto.randomUUID(),
    ...event,
    status: "pending",
    attempts: 0,
    next_attempt_at: now,
    last_error: null,
    created_at: now,
    delivered_at: null,
  }));
  await queryDb(dbx).insert(tableFor(dbx, "eventOutbox")).values(rows);
}

/**
 * Due rows, oldest first. Includes stuck "delivering" rows (crash mid-delivery)
 * whose next_attempt_at has passed — single-replica, so no claim tokens.
 */
export async function selectDueOutbox(limit: number, now = new Date()): Promise<OutboxRow[]> {
  const dbx = getDb();
  const table = tableFor(dbx, "eventOutbox");
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .select()
    .from(table)
    .where(
      and(
        or(eq(table.status, "pending"), eq(table.status, "delivering")),
        lte(table.next_attempt_at, now)
      )
    )
    .orderBy(asc(table.created_at), asc(table.id))
    .limit(limit);
  return rows as unknown as OutboxRow[];
}

/** Stamp rows as in-flight and push next_attempt_at out so a crash retries later. */
export async function markOutboxDelivering(
  ids: string[],
  retryAfterMs: number,
  now = new Date()
): Promise<void> {
  if (ids.length === 0) return;
  const dbx = getDb();
  const table = tableFor(dbx, "eventOutbox");
  await queryDb(dbx)
    .update(table)
    .set({
      status: "delivering",
      next_attempt_at: new Date(now.getTime() + retryAfterMs),
      attempts: sql`${table.attempts} + 1`,
    })
    .where(inArray(table.id, ids));
}

export async function markOutboxDelivered(ids: string[], now = new Date()): Promise<void> {
  if (ids.length === 0) return;
  const dbx = getDb();
  const table = tableFor(dbx, "eventOutbox");
  await queryDb(dbx)
    .update(table)
    .set({ status: "delivered", delivered_at: now, last_error: null })
    .where(inArray(table.id, ids));
}

export async function markOutboxFailedAttempt(
  ids: string[],
  options: { lastError: string; nextAttemptAt: Date; terminal: boolean }
): Promise<void> {
  if (ids.length === 0) return;
  const dbx = getDb();
  const table = tableFor(dbx, "eventOutbox");
  await queryDb(dbx)
    .update(table)
    .set({
      status: options.terminal ? "failed" : "pending",
      next_attempt_at: options.nextAttemptAt,
      last_error: options.lastError.slice(0, 2000),
    })
    .where(inArray(table.id, ids));
}

export async function countOutboxByStatus(): Promise<Record<string, number>> {
  const dbx = getDb();
  const table = tableFor(dbx, "eventOutbox");
  const rows: Array<{ status: string; n: unknown }> = await queryDb(dbx)
    .select({ status: table.status, n: sql`count(*)` })
    .from(table)
    .groupBy(table.status);
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.n ?? 0)]));
}
