/**
 * The active state-DB singleton, isolated from client.ts so that importing the
 * lightweight guards (isDbInitialized/getDb) does not eagerly load the drizzle
 * drivers. client.ts sets the singleton once it has built a DispatcherDb.
 */

import type { DispatcherDb } from "./types.js";

let singleton: DispatcherDb | null = null;

/** The active state DB. Throws if initDispatcherDb() has not run yet. */
export function getDb(): DispatcherDb {
  if (!singleton) {
    throw new Error(
      "Dispatcher state DB not initialized — initDispatcherDb() must run at startup before repos are used"
    );
  }
  return singleton;
}

/** Whether the state DB has been initialized (soft consumers like the log sink use this). */
export function isDbInitialized(): boolean {
  return singleton !== null;
}

export function setDbSingleton(dbx: DispatcherDb): void {
  singleton = dbx;
}

export function setDbForTests(dbx: DispatcherDb): void {
  singleton = dbx;
}

export function resetDbForTests(): void {
  singleton = null;
}
