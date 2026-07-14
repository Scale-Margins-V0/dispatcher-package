import { and, desc, eq, gte, like, lt, lte, or } from "drizzle-orm";
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
  from?: Date;
  to?: Date;
  campaign_id?: string;
  component?: string;
  q?: string;
  cursor?: { ts: Date; id: string };
  limit: number;
};

export type LogPage = {
  logs: AppLogRow[];
  next_cursor: { ts: Date; id: string } | null;
};

export async function queryLogs(query: LogQuery): Promise<LogPage> {
  const dbx = getDb();
  const table = tableFor(dbx, "appLogs");
  const conditions: unknown[] = [];
  if (query.level) conditions.push(eq(table.level, query.level));
  if (query.from) conditions.push(gte(table.ts, query.from));
  if (query.to) conditions.push(lte(table.ts, query.to));
  if (query.campaign_id) conditions.push(eq(table.campaign_id, query.campaign_id));
  if (query.component) conditions.push(eq(table.component, query.component));
  if (query.q) conditions.push(like(table.message, `%${query.q.replaceAll("%", "\\%")}%`));
  if (query.cursor) {
    conditions.push(
      or(
        lt(table.ts, query.cursor.ts),
        and(eq(table.ts, query.cursor.ts), lt(table.id, query.cursor.id))
      )
    );
  }

  let builder = queryDb(dbx).select().from(table);
  if (conditions.length > 0) builder = builder.where(and(...(conditions as never[])));
  const raw: Record<string, unknown>[] = await builder
    .orderBy(desc(table.ts), desc(table.id))
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
