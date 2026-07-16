/**
 * Wire campaign_id → program resolution.
 *
 * ScaleMargin addresses a drip step as `drip_{enrollmentId}_{stepId}`, unique
 * per (sequence × lead × step). Grouping the console by that id would list one
 * "campaign" per recipient per step, so we resolve every send back to its
 * program:
 *
 *   - one-shot campaign → program_id = campaign_id (the wire id IS the campaign)
 *   - drip step         → program_id = drip_sequence_id, from the dispatch metadata
 *
 * Only the dispatch payload carries drip_sequence_id; inbound provider webhooks
 * carry the wire id alone. So dispatches record the mapping here and inbound
 * events read it back.
 */

import { eq, inArray } from "drizzle-orm";
import { getDb, isDbInitialized } from "../client.js";
import { queryDb, tableFor, upsert } from "../dialect-helpers.js";
import type { DispatchProgramRow, ProgramKind } from "../schema/index.js";

export type ProgramRef = {
  program_id: string;
  program_kind: ProgramKind;
  step_id: string | null;
};

/**
 * Parse ScaleMargin's drip wire id. Mirrors parseDripWireCampaignId in the
 * ScaleMargin backend: split on the LAST underscore, because enrollment ids
 * (cuids) never contain one but the format is `drip_<enrollment>_<step>`.
 */
export function parseDripWireCampaignId(
  wireId: string
): { enrollmentId: string; stepId: string } | null {
  if (!wireId.startsWith("drip_")) return null;
  const rest = wireId.slice(5);
  const lastUnderscore = rest.lastIndexOf("_");
  if (lastUnderscore <= 0) return null;
  return {
    enrollmentId: rest.slice(0, lastUnderscore),
    stepId: rest.slice(lastUnderscore + 1),
  };
}

/** Hot-path cache: the map is append-mostly and tiny relative to event volume. */
const cache = new Map<string, ProgramRef>();
const CACHE_MAX = 20_000;

export function resetProgramCacheForTests(): void {
  cache.clear();
}

/** Record the wire → program mapping for a dispatch. Safe to call repeatedly. */
export async function recordDispatchProgram(row: {
  campaign_id: string;
  program_id: string;
  program_kind: ProgramKind;
  step_id: string | null;
  organization_id: string;
}): Promise<void> {
  if (!isDbInitialized()) return;
  const now = new Date();
  await upsert(
    getDb(),
    "dispatchPrograms",
    { ...row, created_at: now, last_seen_at: now },
    ["campaign_id"],
    { program_id: row.program_id, program_kind: row.program_kind, step_id: row.step_id, last_seen_at: now }
  );
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(row.campaign_id, {
    program_id: row.program_id,
    program_kind: row.program_kind,
    step_id: row.step_id,
  });
}

/**
 * Resolve a wire campaign_id to its program.
 *
 * Falls back to treating the send as its own one-shot program. For an unmapped
 * drip (dispatched before this mapping existed) we still recover the step from
 * the wire id, but the sequence is unknowable — those rows stay grouped by send
 * rather than being silently misattributed.
 */
export async function resolveProgram(campaignIds: string[]): Promise<Map<string, ProgramRef>> {
  const out = new Map<string, ProgramRef>();
  const misses: string[] = [];
  for (const id of campaignIds) {
    const hit = cache.get(id);
    if (hit) out.set(id, hit);
    else if (!out.has(id)) misses.push(id);
  }

  if (misses.length > 0 && isDbInitialized()) {
    const dbx = getDb();
    const table = tableFor(dbx, "dispatchPrograms");
    const rows: Record<string, unknown>[] = await queryDb(dbx)
      .select()
      .from(table)
      .where(inArray(table.campaign_id, [...new Set(misses)]));
    for (const raw of rows as unknown as DispatchProgramRow[]) {
      const ref: ProgramRef = {
        program_id: raw.program_id,
        program_kind: raw.program_kind,
        step_id: raw.step_id,
      };
      cache.set(raw.campaign_id, ref);
      out.set(raw.campaign_id, ref);
    }
  }

  for (const id of campaignIds) {
    if (out.has(id)) continue;
    const drip = parseDripWireCampaignId(id);
    out.set(
      id,
      drip
        ? { program_id: id, program_kind: "drip", step_id: drip.stepId }
        : { program_id: id, program_kind: "campaign", step_id: null }
    );
  }
  return out;
}

export type DispatchProgramPayload = {
  campaign_id?: unknown;
  metadata?: {
    organization_id?: string;
    dispatch_kind?: "drip" | "campaign";
    drip_sequence_id?: string;
    step_id?: string;
  };
};

/**
 * Derive a dispatch's program from its payload.
 *
 * ScaleMargin addresses a drip step as `drip_{enrollmentId}_{stepId}`, so the
 * wire id alone can't group a sequence — only `metadata.drip_sequence_id` can.
 * When that's absent (an older sender), fall back to the wire id so the send
 * groups alone rather than colliding with an unrelated program.
 */
export function programOf(payload: DispatchProgramPayload): {
  program_id: string;
  program_kind: ProgramKind;
  step_id: string | null;
} {
  const campaignId = String(payload.campaign_id ?? "unknown");
  const meta = payload.metadata ?? {};
  const isDrip = meta.dispatch_kind === "drip" || campaignId.startsWith("drip_");
  return {
    program_id: isDrip ? (meta.drip_sequence_id ?? campaignId) : campaignId,
    program_kind: isDrip ? "drip" : "campaign",
    step_id: meta.step_id ?? parseDripWireCampaignId(campaignId)?.stepId ?? null,
  };
}

/**
 * Record the program mapping for an incoming dispatch. Never throws — a missing
 * mapping degrades the console's grouping, it must not fail the send.
 */
export async function recordDispatchProgramForPayload(
  payload: DispatchProgramPayload
): Promise<void> {
  const campaignId = String(payload.campaign_id ?? "");
  if (!campaignId || !isDbInitialized()) return;
  try {
    await recordDispatchProgram({
      campaign_id: campaignId,
      ...programOf(payload),
      organization_id: payload.metadata?.organization_id ?? "unknown",
    });
  } catch {
    // Best-effort: the console falls back to grouping this send on its own.
  }
}

export async function getDispatchProgram(campaignId: string): Promise<DispatchProgramRow | null> {
  if (!isDbInitialized()) return null;
  const dbx = getDb();
  const table = tableFor(dbx, "dispatchPrograms");
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .select()
    .from(table)
    .where(eq(table.campaign_id, campaignId));
  return (rows[0] as unknown as DispatchProgramRow) ?? null;
}
