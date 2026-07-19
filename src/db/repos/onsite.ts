/**
 * Repos for the onsite activation subsystem (decisions, activations, sessions,
 * receipts). Written against the dialect helpers so one implementation covers
 * sqlite/mysql/postgres. Secrets are only ever stored/looked-up as hashes; the
 * ciphertext column is opaque here (crypto lives in ../../onsite/crypto.ts).
 */

import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../client.js";
import { insertIgnore, queryDb, tableFor, upsert } from "../dialect-helpers.js";
import type {
  OnsiteActivationRow,
  OnsiteDecisionRow,
  OnsiteReceiptRow,
  OnsiteSessionRow,
} from "../schema/index.js";

// ---------------------------------------------------------------------------
// Decisions (frozen encrypted snapshot, keyed by decision_id)
// ---------------------------------------------------------------------------

/** Insert the frozen decision snapshot once; a later channel reuses it as-is
 * (only updated_at moves) so the personalized creative stays identical. */
export async function upsertOnsiteDecision(
  row: OnsiteDecisionRow
): Promise<void> {
  await upsert(
    getDb(),
    "onsiteDecisions",
    row as unknown as Record<string, unknown>,
    ["decision_id"],
    { updated_at: row.updated_at }
  );
}

export async function getOnsiteDecision(
  decisionId: string
): Promise<OnsiteDecisionRow | null> {
  const dbx = getDb();
  const t = tableFor(dbx, "onsiteDecisions");
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .select()
    .from(t)
    .where(eq(t.decision_id, decisionId));
  return (rows[0] as unknown as OnsiteDecisionRow) ?? null;
}

// ---------------------------------------------------------------------------
// Activations
// ---------------------------------------------------------------------------

const INSERT_CHUNK = 200;

/** Bulk-insert per-recipient activations. A token collision (astronomically
 * unlikely) is ignored rather than aborting the whole batch. */
export async function insertOnsiteActivations(
  rows: OnsiteActivationRow[]
): Promise<void> {
  if (rows.length === 0) return;
  const dbx = getDb();
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await insertIgnore(
      dbx,
      "onsiteActivations",
      rows.slice(i, i + INSERT_CHUNK) as unknown as Record<string, unknown>[],
      ["token_hash"]
    );
  }
}

export async function getActivationByTokenHash(
  tokenHash: string
): Promise<OnsiteActivationRow | null> {
  const dbx = getDb();
  const t = tableFor(dbx, "onsiteActivations");
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .select()
    .from(t)
    .where(eq(t.token_hash, tokenHash));
  return (rows[0] as unknown as OnsiteActivationRow) ?? null;
}

export async function getActivationById(
  id: string
): Promise<OnsiteActivationRow | null> {
  const dbx = getDb();
  const t = tableFor(dbx, "onsiteActivations");
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .select()
    .from(t)
    .where(eq(t.id, id));
  return (rows[0] as unknown as OnsiteActivationRow) ?? null;
}

/**
 * Atomically bind the first visitor nonce: set it only while still NULL. The
 * `visitor_nonce_hash IS NULL` guard is what makes binding first-writer-wins —
 * a second browser's redeem changes no rows, and the caller then compares the
 * stored hash to decide idempotent (same nonce) vs conflict (different nonce).
 * Returns true iff THIS call performed the bind.
 */
export async function bindActivationNonce(
  id: string,
  nonceHash: string,
  now: Date
): Promise<boolean> {
  const dbx = getDb();
  const t = tableFor(dbx, "onsiteActivations");
  const result = await queryDb(dbx)
    .update(t)
    .set({ visitor_nonce_hash: nonceHash, status: "bound", bound_at: now })
    .where(and(eq(t.id, id), isNull(t.visitor_nonce_hash)));
  return affectedRows(dbx.dialect, result) > 0;
}

/** Normalize the per-driver "rows changed" signal into a number. */
function affectedRows(dialect: string, result: unknown): number {
  if (dialect === "sqlite") {
    return Number((result as { changes?: number })?.changes ?? 0);
  }
  if (dialect === "mysql") {
    const header = Array.isArray(result) ? result[0] : result;
    return Number((header as { affectedRows?: number })?.affectedRows ?? 0);
  }
  return Number((result as { rowCount?: number })?.rowCount ?? 0);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function insertOnsiteSession(
  row: OnsiteSessionRow
): Promise<void> {
  const dbx = getDb();
  const t = tableFor(dbx, "onsiteSessions");
  await queryDb(dbx)
    .insert(t)
    .values(row as unknown as Record<string, unknown>);
}

export async function getSessionByTokenHash(
  sessionTokenHash: string
): Promise<OnsiteSessionRow | null> {
  const dbx = getDb();
  const t = tableFor(dbx, "onsiteSessions");
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .select()
    .from(t)
    .where(eq(t.session_token_hash, sessionTokenHash));
  return (rows[0] as unknown as OnsiteSessionRow) ?? null;
}

/** Slide the idle window forward. */
export async function touchOnsiteSession(id: string, now: Date): Promise<void> {
  const dbx = getDb();
  const t = tableFor(dbx, "onsiteSessions");
  await queryDb(dbx).update(t).set({ last_seen_at: now }).where(eq(t.id, id));
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/** Insert a receipt; a duplicate receipt_id (client retry) is silently ignored. */
export async function insertOnsiteReceipt(
  row: OnsiteReceiptRow
): Promise<void> {
  await insertIgnore(
    getDb(),
    "onsiteReceipts",
    [row as unknown as Record<string, unknown>],
    ["receipt_id"]
  );
}
