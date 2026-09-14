/**
 * DB-backed placeholder registry with an in-process snapshot.
 * personalize() reads the snapshot synchronously; admin writes refresh it
 * immediately; a TTL keeps a (future) multi-replica setup from drifting for
 * more than ~30s.
 */

import { isDbInitialized } from "../db/client.js";
import { listVariables } from "../db/repos/variables.js";
import { rowToPlaceholderEntry } from "./mapping.js";
import type { PlaceholderEntry } from "../user-lookup/config.js";
import { componentLogger } from "../logging/logger.js";
import { inactiveSources } from "./guard.js";

const log = componentLogger("variables");

const TTL_MS = 30_000;

let snapshot: Record<string, PlaceholderEntry> | null = null;
let loadedAt = 0;

/** Sync hot-path accessor. `null` until the first refresh (or when DB is off). */
export function getPlaceholderSnapshot(): Record<string, PlaceholderEntry> | null {
  return snapshot;
}

export async function refreshPlaceholders(): Promise<void> {
  if (!isDbInitialized()) return;
  const rows = await listVariables();
  const inactive = new Set(inactiveSources());
  const next: Record<string, PlaceholderEntry> = {};
  let skipped = 0;

  for (const row of rows) {
    if (!row.enabled) continue;
    // Retained in the table, just not resolvable here — switching back to a
    // database lookup restores them untouched.
    if (inactive.has(row.source as PlaceholderEntry["source"])) {
      skipped += 1;
      continue;
    }
    next[row.name] = rowToPlaceholderEntry(row);
  }

  // One aggregated line, not one per variable: a campaign with fifty of these
  // should not produce fifty warnings.
  if (skipped > 0) {
    log.warn(
      { count: skipped, sources: [...inactive], error_category: "unsupported_variable_source" },
      `${skipped} variable(s) need a SQL connection and are inactive in this lookup mode — their fallbacks are used`
    );
  }

  snapshot = next;
  loadedAt = Date.now();
}

/** Force the next ensurePlaceholdersFresh() to hit the DB. */
export function invalidatePlaceholders(): void {
  loadedAt = 0;
}

/** Called once per dispatch request so a whole campaign never runs on a stale set. */
export async function ensurePlaceholdersFresh(): Promise<void> {
  if (!isDbInitialized()) return;
  if (snapshot !== null && Date.now() - loadedAt <= TTL_MS) return;
  await refreshPlaceholders();
}

export function resetPlaceholdersForTests(): void {
  snapshot = null;
  loadedAt = 0;
}
