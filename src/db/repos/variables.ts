import { asc, eq } from "drizzle-orm";
import { getDb } from "../client.js";
import { queryDb, tableFor } from "../dialect-helpers.js";
import type { VariableRow, VariableSource } from "../schema/index.js";

export type NewVariable = {
  name: string;
  source: VariableSource;
  field?: string | null;
  expr?: string | null;
  fallback?: string | null;
  enabled?: boolean;
  updated_by?: string | null;
};

function toRow(raw: Record<string, unknown>): VariableRow {
  return {
    id: raw.id as string,
    name: raw.name as string,
    source: raw.source as VariableSource,
    field: (raw.field as string | null) ?? null,
    expr: (raw.expr as string | null) ?? null,
    fallback: (raw.fallback as string | null) ?? null,
    enabled: Boolean(raw.enabled),
    created_at: raw.created_at as Date,
    updated_at: raw.updated_at as Date,
    updated_by: (raw.updated_by as string | null) ?? null,
  };
}

export async function listVariables(): Promise<VariableRow[]> {
  const dbx = getDb();
  const table = tableFor(dbx, "variables");
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .select()
    .from(table)
    .orderBy(asc(table.name));
  return rows.map(toRow);
}

export async function getVariable(name: string): Promise<VariableRow | null> {
  const dbx = getDb();
  const table = tableFor(dbx, "variables");
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .select()
    .from(table)
    .where(eq(table.name, name));
  return rows[0] ? toRow(rows[0]) : null;
}

export async function createVariable(input: NewVariable): Promise<VariableRow> {
  const dbx = getDb();
  const table = tableFor(dbx, "variables");
  const now = new Date();
  const row = {
    id: crypto.randomUUID(),
    name: input.name,
    source: input.source,
    field: input.field ?? null,
    expr: input.expr ?? null,
    fallback: input.fallback ?? null,
    enabled: input.enabled ?? true,
    created_at: now,
    updated_at: now,
    updated_by: input.updated_by ?? null,
  };
  await queryDb(dbx).insert(table).values(row);
  return toRow(row);
}

export async function updateVariable(
  name: string,
  patch: Partial<NewVariable>
): Promise<VariableRow | null> {
  const dbx = getDb();
  const table = tableFor(dbx, "variables");
  const existing = await getVariable(name);
  if (!existing) return null;
  const set: Record<string, unknown> = { updated_at: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.source !== undefined) set.source = patch.source;
  if (patch.field !== undefined) set.field = patch.field;
  if (patch.expr !== undefined) set.expr = patch.expr;
  if (patch.fallback !== undefined) set.fallback = patch.fallback;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.updated_by !== undefined) set.updated_by = patch.updated_by;
  await queryDb(dbx).update(table).set(set).where(eq(table.name, name));
  return getVariable((patch.name as string | undefined) ?? name);
}

export async function deleteVariable(name: string): Promise<boolean> {
  const dbx = getDb();
  const table = tableFor(dbx, "variables");
  const existing = await getVariable(name);
  if (!existing) return false;
  await queryDb(dbx).delete(table).where(eq(table.name, name));
  return true;
}

export async function countVariables(): Promise<number> {
  return (await listVariables()).length;
}
