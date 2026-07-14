/**
 * State-DB bootstrap: build client → run migrations → post-init hooks.
 * Called once from src/index.ts before the event pipeline starts.
 */

import { initAuth } from "../auth/index.js";
import { seedDefaultAdmin } from "../auth/seed.js";
import { warmCampaignCallbackCache } from "../events/campaign-callback-registry.js";
import { importYamlPlaceholdersOnce } from "../variables/import-yaml.js";
import { createDispatcherDb, isDbInitialized, getDb, setDbSingleton, type DispatcherDb } from "./client.js";
import { runDispatcherMigrations } from "./migrate.js";
import { startRetentionJob } from "./retention.js";

export async function initDispatcherDb(): Promise<DispatcherDb> {
  if (isDbInitialized()) return getDb();
  const dbx = createDispatcherDb();
  await runDispatcherMigrations(dbx);
  setDbSingleton(dbx);
  initAuth();
  await seedDefaultAdmin();
  await importYamlPlaceholdersOnce();
  await warmCampaignCallbackCache();
  startRetentionJob();
  return dbx;
}
