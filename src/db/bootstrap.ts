/**
 * State-DB bootstrap: build client → run migrations → post-init hooks.
 * Called once from src/index.ts before the event pipeline starts.
 */

import { importYamlPlaceholdersOnce } from "../variables/import-yaml.js";
import { createDispatcherDb, isDbInitialized, getDb, setDbSingleton, type DispatcherDb } from "./client.js";
import { runDispatcherMigrations } from "./migrate.js";

export async function initDispatcherDb(): Promise<DispatcherDb> {
  if (isDbInitialized()) return getDb();
  const dbx = createDispatcherDb();
  await runDispatcherMigrations(dbx);
  setDbSingleton(dbx);
  await importYamlPlaceholdersOnce();
  return dbx;
}
