import { and, asc, desc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
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

export type OutboxPage = { rows: OutboxRow[]; next_cursor: { ts: Date; id: string } | null };

/** Forwarding attempts for one campaign, newest first (campaign Forwarding tab). */
export async function listOutboxByCampaign(options: {
  campaign_id: string;
  status?: string;
  cursor?: { ts: Date; id: string };
  limit: number;
}): Promise<OutboxPage> {
  const dbx = getDb();
  const table = tableFor(dbx, "eventOutbox");
  const conditions: unknown[] = [eq(table.campaign_id, options.campaign_id)];
  if (options.status) conditions.push(eq(table.status, options.status));
  if (options.cursor) {
    conditions.push(
      or(
        lt(table.created_at, options.cursor.ts),
        and(eq(table.created_at, options.cursor.ts), lt(table.id, options.cursor.id))
      )
    );
  }
  const raw: Record<string, unknown>[] = await queryDb(dbx)
    .select()
    .from(table)
    .where(and(...(conditions as never[])))
    .orderBy(desc(table.created_at), desc(table.id))
    .limit(options.limit + 1);
  const rows = raw as unknown as OutboxRow[];
  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  const last = page[page.length - 1];
  return {
    rows: page,
    next_cursor: hasMore && last ? { ts: last.created_at, id: last.id } : null,
  };
}

export async function countOutboxByStatusForCampaign(
  campaign_id: string
): Promise<Record<string, number>> {
  const dbx = getDb();
  const table = tableFor(dbx, "eventOutbox");
  const rows: Array<{ status: string; n: unknown }> = await queryDb(dbx)
    .select({ status: table.status, n: sql`count(*)` })
    .from(table)
    .where(eq(table.campaign_id, campaign_id))
    .groupBy(table.status);
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.n ?? 0)]));
}
