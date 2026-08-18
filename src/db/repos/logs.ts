import { and, asc, count, desc, eq, gt, gte, inArray, like, lt, lte, or } from "drizzle-orm";
import { getDb } from "../client.js";
import { queryDb, tableFor } from "../dialect-helpers.js";
import type { AppLogRow, LogLevel } from "../schema/index.js";

function toRow(raw: Record<string, unknown>): AppLogRow {
  return {
    id: raw.id as string,
    ts: raw.ts as Date,
    level: raw.level as LogLevel,
    request_id: (raw.request_id as string | null) ?? null,
    campaign_id: (raw.campaign_id as string | null) ?? null,
    component: (raw.component as string | null) ?? null,
    message: raw.message as string,
    stack: (raw.stack as string | null) ?? null,
    context: (raw.context as Record<string, unknown> | null) ?? null,
  };
}

export async function insertLogs(rows: AppLogRow[]): Promise<void> {
  if (rows.length === 0) return;
  const dbx = getDb();
  await queryDb(dbx).insert(tableFor(dbx, "appLogs")).values(rows);
}

export type LogQuery = {
  level?: LogLevel;
  /** Match any of these levels (e.g. min-level expansion). Ignored if `level` set. */
  levels?: LogLevel[];
  from?: Date;
  to?: Date;
  campaign_id?: string;
  component?: string;
  request_id?: string;
  q?: string;
  cursor?: { ts: Date; id: string };
  order?: "asc" | "desc";
  limit: number;
};

export type LogPage = {
  logs: AppLogRow[];
  next_cursor: { ts: Date; id: string } | null;
};

/** Shared WHERE, so a count and its page can never disagree about the filter. */
function logConditions(table: any, query: Omit<LogQuery, "limit" | "cursor" | "order">): unknown[] {
  const conditions: unknown[] = [];
  if (query.level) conditions.push(eq(table.level, query.level));
  else if (query.levels && query.levels.length > 0) conditions.push(inArray(table.level, query.levels));
  if (query.from) conditions.push(gte(table.ts, query.from));
  if (query.to) conditions.push(lte(table.ts, query.to));
  if (query.campaign_id) conditions.push(eq(table.campaign_id, query.campaign_id));
  if (query.component) conditions.push(eq(table.component, query.component));
  if (query.request_id) conditions.push(eq(table.request_id, query.request_id));
  if (query.q) conditions.push(like(table.message, `%${query.q.replaceAll("%", "\\%")}%`));
  return conditions;
}

export type LogFilters = Omit<LogQuery, "limit" | "cursor" | "order">;

export async function countLogs(filters: LogFilters): Promise<number> {
  const dbx = getDb();
  const table = tableFor(dbx, "appLogs");
  const conditions = logConditions(table, filters);
  let builder = queryDb(dbx).select({ total: count().as("total") }).from(table);
  if (conditions.length > 0) builder = builder.where(and(...(conditions as never[])));
  const [row]: Array<{ total: unknown }> = await builder;
  return Number(row?.total) || 0;
}

/**
 * One offset page, newest first.
 *
 * ponytail: OFFSET, not the keyset cursor queryLogs() uses. The API caps `limit`
 * at 100 and an operator reading logs by hand never pages deep enough for it to
 * matter; anything that walks the table should use queryLogs().
 */
export async function queryLogsPage(
  filters: LogFilters,
  page: { offset: number; limit: number; order?: "asc" | "desc" }
): Promise<AppLogRow[]> {
  const dbx = getDb();
  const table = tableFor(dbx, "appLogs");
  const ascending = page.order === "asc";
  const conditions = logConditions(table, filters);
  let builder = queryDb(dbx).select().from(table);
  if (conditions.length > 0) builder = builder.where(and(...(conditions as never[])));
  const raw: Record<string, unknown>[] = await builder
    .orderBy(ascending ? asc(table.ts) : desc(table.ts), ascending ? asc(table.id) : desc(table.id))
    .limit(page.limit)
    .offset(page.offset);
  return raw.map(toRow);
}

export async function queryLogs(query: LogQuery): Promise<LogPage> {
  const dbx = getDb();
  const table = tableFor(dbx, "appLogs");
  const ascending = query.order === "asc";
  const conditions = logConditions(table, query);
  if (query.cursor) {
    // Keyset: page in the same direction as the sort order (ts then id tiebreak).
    conditions.push(
      ascending
        ? or(
            gt(table.ts, query.cursor.ts),
            and(eq(table.ts, query.cursor.ts), gt(table.id, query.cursor.id))
          )
        : or(
            lt(table.ts, query.cursor.ts),
            and(eq(table.ts, query.cursor.ts), lt(table.id, query.cursor.id))
          )
    );
  }

  let builder = queryDb(dbx).select().from(table);
  if (conditions.length > 0) builder = builder.where(and(...(conditions as never[])));
  const orderTs = ascending ? asc(table.ts) : desc(table.ts);
  const orderId = ascending ? asc(table.id) : desc(table.id);
  const raw: Record<string, unknown>[] = await builder
    .orderBy(orderTs, orderId)
    .limit(query.limit + 1);

  const rows = raw.map(toRow);
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  return {
    logs: page,
    next_cursor: hasMore && last ? { ts: last.ts, id: last.id } : null,
  };
}

export async function getLogById(id: string): Promise<AppLogRow | null> {
  const dbx = getDb();
  const table = tableFor(dbx, "appLogs");
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .select()
    .from(table)
    .where(eq(table.id, id));
  return rows[0] ? toRow(rows[0]) : null;
}
