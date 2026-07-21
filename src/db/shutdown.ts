import { isDbInitialized, getDb, resetDbForTests } from "./client.js";

/** Close pools/handles. Safe to call when the DB was never initialized. */
export async function closeDispatcherDb(): Promise<void> {
  if (!isDbInitialized()) return;
  const dbx = getDb();
  resetDbForTests();
  try {
    if (dbx.dialect === "sqlite") {
      dbx.sqlite.close();
    } else {
      await dbx.pool.end();
    }
  } catch {
    // Shutdown path — never throw.
  }
}
