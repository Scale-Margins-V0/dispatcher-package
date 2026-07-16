/**
 * The one place where per-dialect SQL syntax differences are handled.
 * Repos are written once against these helpers; type safety lives at the repo
 * API boundary (shared row types), so the internals use narrow casts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { DispatcherDb } from "./client.js";
import type { SqliteTables } from "./schema/index.js";

export type StateTableName = keyof SqliteTables;

/** The active dialect's drizzle table object for a logical table name. */
export function tableFor(dbx: DispatcherDb, name: StateTableName): any {
  return (dbx.tables as any)[name];
}

/**
 * The drizzle instance widened for cross-dialect query building. The three
 * database types share the select/insert/update/delete surface; TS can't unify
 * them, so repos build queries through this and type their own boundaries.
 */
export function queryDb(dbx: DispatcherDb): any {
  return dbx.db;
}

/**
 * Cross-dialect upsert. `conflictKeys` are TS property names on the table
 * (identical across the three schema files); ignored by MySQL, which keys on
 * the primary/unique constraint itself.
 */
export async function upsert(
  dbx: DispatcherDb,
  name: StateTableName,
  values: Record<string, unknown>,
  conflictKeys: string[],
  updateSet: Record<string, unknown>
): Promise<void> {
  const table = tableFor(dbx, name);
  if (dbx.dialect === "mysql") {
    await dbx.db.insert(table).values(values as any).onDuplicateKeyUpdate({ set: updateSet as any });
    return;
  }
  const target = conflictKeys.map((key) => table[key]);
  await (dbx.db as any)
    .insert(table)
    .values(values)
    .onConflictDoUpdate({ target, set: updateSet });
}

/**
 * Cross-dialect insert-or-skip. Rows whose `conflictKeys` collide with an
 * existing row are silently dropped (MySQL uses INSERT IGNORE, which keys on
 * any unique constraint; sqlite/pg target the named columns).
 */
export async function insertIgnore(
  dbx: DispatcherDb,
  name: StateTableName,
  rows: Record<string, unknown>[],
  conflictKeys: string[]
): Promise<void> {
  if (rows.length === 0) return;
  const table = tableFor(dbx, name);
  if (dbx.dialect === "mysql") {
    await (dbx.db as any).insert(table).ignore().values(rows);
    return;
  }
  const target = conflictKeys.map((key) => table[key]);
  await (dbx.db as any).insert(table).values(rows).onConflictDoNothing({ target });
}
