import { eq } from "drizzle-orm";
import { getDb } from "../client.js";
import { queryDb, tableFor, upsert } from "../dialect-helpers.js";
import type { MetaRow } from "../schema/index.js";

export async function getMeta(key: string): Promise<string | null> {
  const dbx = getDb();
  const table = tableFor(dbx, "dispatcherMeta");
  const rows: MetaRow[] = await queryDb(dbx).select().from(table).where(eq(table.key, key));
  return rows[0]?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await upsert(
    getDb(),
    "dispatcherMeta",
    { key, value, updated_at: new Date() },
    ["key"],
    { value, updated_at: new Date() }
  );
}
