/**
 * DB-backed placeholder registry with an in-process snapshot.
 * personalize() reads the snapshot synchronously; admin writes refresh it
 * immediately; a TTL keeps a (future) multi-replica setup from drifting for
 * more than ~30s.
 */

import { isDbInitialized } from "../db/client.js";
import { listVariables } from "../db/repos/variables.js";
import type { PlaceholderEntry } from "../user-lookup/config.js";

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
  const next: Record<string, PlaceholderEntry> = {};
  for (const row of rows) {
    if (!row.enabled) continue;
    if (row.source === "field") {
      next[row.name] = {
        source: "field",
        field: row.field ?? "",
        ...(row.fallback !== null ? { fallback: row.fallback } : {}),
      };
    } else {
      next[row.name] = {
        source: "computed",
        expr: row.expr ?? "",
        ...(row.fallback !== null ? { fallback: row.fallback } : {}),
      };
    }
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
