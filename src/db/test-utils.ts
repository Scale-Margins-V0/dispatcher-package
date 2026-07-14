/**
 * Spec-only helpers. Creates an in-memory SQLite state DB with migrations applied
 * and installs it as the process singleton.
 */

import { createDispatcherDb, resetDbForTests, setDbForTests, type DispatcherDb } from "./client.js";
import { runDispatcherMigrations } from "./migrate.js";

export async function createTestDb(): Promise<DispatcherDb> {
  const dbx = createDispatcherDb({ dialect: "sqlite", file: ":memory:" });
  await runDispatcherMigrations(dbx);
  setDbForTests(dbx);
  return dbx;
}

export function destroyTestDb(dbx: DispatcherDb): void {
  resetDbForTests();
  if (dbx.dialect === "sqlite") dbx.sqlite.close();
}
