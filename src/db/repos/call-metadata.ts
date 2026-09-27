/**
 * Call metadata schemas. Addressed by `name` on the API (like variables) but
 * referenced by `id` from api variables, so a rename never breaks one.
 */

import { asc, eq } from "drizzle-orm";
import { getDb } from "../client.js";
import { queryDb, tableFor } from "../dialect-helpers.js";
import type { CallMetadataKey, CallMetadataRow } from "../schema/index.js";

export type NewCallMetadata = {
  name: string;
  keys: CallMetadataKey[];
  updated_by?: string | null;
};

/** JSON columns come back parsed (pg/mysql) or as a string (some sqlite paths). */
function parseKeys(raw: unknown): CallMetadataKey[] {
  const value = typeof raw === "string" ? safeJson(raw) : raw;
  return Array.isArray(value) ? (value as CallMetadataKey[]) : [];
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toRow(raw: Record<string, unknown>): CallMetadataRow {
  return {
    id: raw.id as string,
    name: raw.name as string,
    keys: parseKeys(raw.keys),
    created_at: raw.created_at as Date,
    updated_at: raw.updated_at as Date,
    updated_by: (raw.updated_by as string | null) ?? null,
  };
}

export async function listCallMetadata(): Promise<CallMetadataRow[]> {
  const dbx = getDb();
  const table = tableFor(dbx, "callMetadata");
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .select()
    .from(table)
    .orderBy(asc(table.name));
  return rows.map(toRow);
}

async function getBy(column: "name" | "id", value: string): Promise<CallMetadataRow | null> {
  const dbx = getDb();
  const table = tableFor(dbx, "callMetadata");
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .select()
    .from(table)
    .where(eq(table[column], value));
  return rows[0] ? toRow(rows[0]) : null;
}

export const getCallMetadata = (name: string) => getBy("name", name);
export const getCallMetadataById = (id: string) => getBy("id", id);

export async function createCallMetadata(input: NewCallMetadata): Promise<CallMetadataRow> {
  const dbx = getDb();
  const table = tableFor(dbx, "callMetadata");
  const now = new Date();
  const row = {
    id: crypto.randomUUID(),
    name: input.name,
    keys: input.keys,
    created_at: now,
    updated_at: now,
    updated_by: input.updated_by ?? null,
  };
  await queryDb(dbx).insert(table).values(row);
  return toRow(row);
}

export async function updateCallMetadata(
  name: string,
  patch: Partial<NewCallMetadata>
): Promise<CallMetadataRow | null> {
  const dbx = getDb();
  const table = tableFor(dbx, "callMetadata");
  if (!(await getCallMetadata(name))) return null;
  const set: Record<string, unknown> = { updated_at: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.keys !== undefined) set.keys = patch.keys;
  if (patch.updated_by !== undefined) set.updated_by = patch.updated_by;
  await queryDb(dbx).update(table).set(set).where(eq(table.name, name));
  return getCallMetadata(patch.name ?? name);
}

export async function deleteCallMetadata(name: string): Promise<boolean> {
  const dbx = getDb();
  const table = tableFor(dbx, "callMetadata");
  if (!(await getCallMetadata(name))) return false;
  await queryDb(dbx).delete(table).where(eq(table.name, name));
  return true;
}
