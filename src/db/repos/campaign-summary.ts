/**
 * Durable per-campaign rollup.
 *
 * Everything here already exists elsewhere — dispatch_runs holds the send
 * counters, campaign_events holds the engagement funnel. What does not exist is
 * a copy that survives retention: campaign_events is pruned at 90 days / 500k
 * rows, so a funnel computed on read silently empties out as a campaign ages.
 * This table is never pruned.
 *
 * **Recomputed, never incremented.** Inbound webhooks are de-duplicated by
 * insert-ignore on `dedupe_key`, which cannot report how many rows it actually
 * inserted — so a delta-based counter would climb on every provider retry with
 * no way to detect the drift. Recomputing from the source tables is idempotent
 * and self-healing: run it twice, get the same row.
 */

import { and, asc, count, desc, eq, gte, inArray, like, lte, sql } from "drizzle-orm";
import { getDb, isDbInitialized } from "../client.js";
import { queryDb, tableFor, upsert } from "../dialect-helpers.js";
import { componentLogger } from "../../logging/logger.js";
import { getCampaignFunnel } from "./campaign-events.js";
import type { CampaignSummaryRollupRow, ProgramKind } from "../schema/index.js";

const log = componentLogger("db.campaign-summary");

const num = (value: unknown): number => Number(value ?? 0);

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(Number(value) || String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

export type RunTotals = {
  program_kind: ProgramKind;
  organization_id: string | null;
  channel: string | null;
  provider: string | null;
  total_recipients: number;
  sent: number;
  failed: number;
  resolution_total: number;
  resolution_fallbacks: number;
  first_send_at: Date | null;
  last_run_at: Date | null;
  runs: number;
};

/**
 * Send-side totals for one program, from dispatch_runs.
 *
 * Only `completed` runs contribute counters: an `accepted` row is a run still in
 * flight whose sent/failed are still null, and a `failed` row never sent
 * anything. Identity fields (channel, provider, org) come from the most recent
 * run of any status, so a program that has only ever been accepted still
 * describes itself correctly.
 */
export async function sumRunsForProgram(program_id: string): Promise<RunTotals | null> {
  const dbx = getDb();
  const runs = tableFor(dbx, "dispatchRuns");

  const [totals]: Record<string, unknown>[] = await queryDb(dbx)
    .select({
      total_recipients: sql`coalesce(sum(${runs.recipient_count}), 0)`,
      sent: sql`coalesce(sum(${runs.sent_count}), 0)`,
      failed: sql`coalesce(sum(${runs.failed_count}), 0)`,
      resolution_total: sql`coalesce(sum(${runs.resolution_total}), 0)`,
      resolution_fallbacks: sql`coalesce(sum(${runs.resolution_fallbacks}), 0)`,
      runs: sql`count(*)`,
      first_send_at: sql`min(${runs.occurred_at})`,
      last_run_at: sql`max(${runs.occurred_at})`,
    })
    .from(runs)
    .where(and(eq(runs.program_id, program_id), eq(runs.status, "completed")));

  // Identity from the latest run, whatever its status.
  const [latest]: Record<string, unknown>[] = await queryDb(dbx)
    .select()
    .from(runs)
    .where(eq(runs.program_id, program_id))
    .orderBy(desc(runs.occurred_at), desc(runs.id))
    .limit(1);

  if (!latest) return null;

  return {
    program_kind: (latest.program_kind as ProgramKind) ?? "campaign",
    organization_id: (latest.organization_id as string | null) ?? null,
    channel: (latest.channel as string | null) ?? null,
    provider: (latest.provider as string | null) ?? null,
    total_recipients: num(totals?.total_recipients),
    sent: num(totals?.sent),
    failed: num(totals?.failed),
    resolution_total: num(totals?.resolution_total),
    resolution_fallbacks: num(totals?.resolution_fallbacks),
    first_send_at: toDate(totals?.first_send_at),
    last_run_at: toDate(totals?.last_run_at),
    runs: num(totals?.runs),
  };
}

/** Most recent non-null template_ref seen on a send for this program. */
async function latestTemplateRef(program_id: string): Promise<string | null> {
  const dbx = getDb();
  const logs = tableFor(dbx, "dispatchSendLogs");
  const [row]: Record<string, unknown>[] = await queryDb(dbx)
    .select({ template_ref: logs.template_ref })
    .from(logs)
    .where(and(eq(logs.program_id, program_id), sql`${logs.template_ref} is not null`))
    .orderBy(desc(logs.occurred_at))
    .limit(1);
  return (row?.template_ref as string | null) ?? null;
}

export async function getCampaignSummary(
  program_id: string
): Promise<CampaignSummaryRollupRow | null> {
  const dbx = getDb();
  const table = tableFor(dbx, "campaignSummary");
  const [row]: Record<string, unknown>[] = await queryDb(dbx)
    .select()
    .from(table)
    .where(eq(table.program_id, program_id));
  return row ? (row as unknown as CampaignSummaryRollupRow) : null;
}

/**
 * Recompute one program's rollup from dispatch_runs + campaign_events.
 *
 * Counters never move backwards. Once the events behind a campaign are pruned a
 * recompute would report near-zero, so each stage takes `max(stored, computed)`.
 * That makes a late event on an aged campaign harmless — it can only ever raise
 * a number, which is the correct direction for append-only stages.
 */
export async function refreshCampaignSummary(program_id: string): Promise<void> {
  if (!isDbInitialized() || !program_id) return;

  const [runTotals, funnel, existing] = await Promise.all([
    sumRunsForProgram(program_id),
    getCampaignFunnel(program_id),
    getCampaignSummary(program_id),
  ]);

  // Nothing has ever dispatched under this id and no row exists to maintain.
  if (!runTotals && !existing) return;

  const keep = (stored: number | null | undefined, computed: number): number =>
    Math.max(Number(stored ?? 0), computed);

  const templateRef = (await latestTemplateRef(program_id)) ?? existing?.template_ref ?? null;
  const lastEventAt = [runTotals?.last_run_at, existing?.last_event_at]
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

  const row: CampaignSummaryRollupRow = {
    program_id,
    program_kind: runTotals?.program_kind ?? existing?.program_kind ?? "campaign",
    organization_id: runTotals?.organization_id ?? existing?.organization_id ?? null,
    channel: runTotals?.channel ?? existing?.channel ?? null,
    provider: runTotals?.provider ?? existing?.provider ?? null,
    template_ref: templateRef,
    total_recipients: keep(existing?.total_recipients, runTotals?.total_recipients ?? 0),
    sent: keep(existing?.sent, runTotals?.sent ?? 0),
    failed: keep(existing?.failed, runTotals?.failed ?? 0),
    fallbacks_used:
      runTotals && runTotals.resolution_total > 0
        ? keep(existing?.fallbacks_used, runTotals.resolution_fallbacks)
        : (existing?.fallbacks_used ?? null),
    unique_recipients: keep(existing?.unique_recipients, funnel.unique_recipients),
    dispatched: keep(existing?.dispatched, funnel.dispatched),
    delivered: keep(existing?.delivered, funnel.delivered),
    // WhatsApp read receipts are a view signal on a channel with no pixel, so
    // they belong in `opened` here even though the event store keeps them apart.
    opened: keep(existing?.opened, funnel.opened + funnel.read),
    clicked: keep(existing?.clicked, funnel.clicked),
    bounced: keep(existing?.bounced, funnel.bounced),
    complained: keep(existing?.complained, funnel.complained),
    unsubscribed: keep(existing?.unsubscribed, funnel.unsubscribed),
    first_send_at: existing?.first_send_at ?? runTotals?.first_send_at ?? null,
    last_event_at: lastEventAt,
    updated_at: new Date(),
  };

  const { program_id: _pk, ...updateSet } = row;
  await upsert(getDb(), "campaignSummary", row, ["program_id"], updateSet);
}

/** Never let bookkeeping fail a dispatch or a webhook. */
export function refreshCampaignSummarySafe(program_id: string): void {
  void refreshCampaignSummary(program_id).catch((error: unknown) => {
    log.warn(
      { err: error instanceof Error ? error : new Error(String(error)) },
      `Failed to refresh campaign summary for ${program_id}`
    );
  });
}

/**
 * Rebuild every rollup from scratch. Used once at bootstrap to backfill
 * campaigns that predate this table, and available for repair afterwards.
 */
export async function rebuildAllCampaignSummaries(): Promise<{ rebuilt: number }> {
  if (!isDbInitialized()) return { rebuilt: 0 };
  const dbx = getDb();
  const runs = tableFor(dbx, "dispatchRuns");
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .selectDistinct({ program_id: runs.program_id })
    .from(runs)
    .orderBy(asc(runs.program_id));

  let rebuilt = 0;
  for (const row of rows) {
    const programId = String(row.program_id ?? "");
    if (!programId) continue;
    await refreshCampaignSummary(programId);
    rebuilt += 1;
  }
  return { rebuilt };
}

export type CampaignSummaryQuery = {
  organization_id?: string;
  channel?: string;
  program_kind?: ProgramKind;
  /** Case-insensitive substring match on program_id. */
  q?: string;
  from?: Date;
  to?: Date;
};

/** Shared WHERE, so the count and the page can never disagree about the filter. */
function summaryConditions(table: any, filters: CampaignSummaryQuery): unknown[] {
  const conditions: unknown[] = [];
  if (filters.organization_id) {
    conditions.push(eq(table.organization_id, filters.organization_id));
  }
  if (filters.channel) conditions.push(eq(table.channel, filters.channel));
  if (filters.program_kind) conditions.push(eq(table.program_kind, filters.program_kind));
  if (filters.q) conditions.push(like(table.program_id, `%${filters.q}%`));
  if (filters.from) conditions.push(gte(table.last_event_at, filters.from));
  if (filters.to) conditions.push(lte(table.last_event_at, filters.to));
  return conditions;
}

export async function countCampaignSummaries(filters: CampaignSummaryQuery): Promise<number> {
  const dbx = getDb();
  const table = tableFor(dbx, "campaignSummary");
  const conditions = summaryConditions(table, filters);
  let builder = queryDb(dbx).select({ total: count().as("total") }).from(table);
  if (conditions.length > 0) builder = builder.where(and(...(conditions as never[])));
  const [row]: Array<{ total: unknown }> = await builder;
  return Number(row?.total) || 0;
}

/**
 * Filtered rollups, newest activity first.
 *
 * `page` is optional so callers that genuinely want everything (tests, a future
 * export) can still ask for it; the API always passes one.
 */
export async function listCampaignSummaries(
  filters: CampaignSummaryQuery,
  page?: { offset: number; limit: number }
): Promise<CampaignSummaryRollupRow[]> {
  const dbx = getDb();
  const table = tableFor(dbx, "campaignSummary");
  const conditions = summaryConditions(table, filters);

  let builder = queryDb(dbx).select().from(table);
  if (conditions.length > 0) builder = builder.where(and(...(conditions as never[])));
  builder = builder.orderBy(desc(table.last_event_at), desc(table.program_id));
  if (page) builder = builder.limit(page.limit).offset(page.offset);
  const rows: Record<string, unknown>[] = await builder;
  return rows as unknown as CampaignSummaryRollupRow[];
}

/** Rollups for a set of programs, for callers that already have the ids. */
export async function getCampaignSummaries(
  programIds: string[]
): Promise<Map<string, CampaignSummaryRollupRow>> {
  const out = new Map<string, CampaignSummaryRollupRow>();
  if (programIds.length === 0) return out;
  const dbx = getDb();
  const table = tableFor(dbx, "campaignSummary");
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .select()
    .from(table)
    .where(inArray(table.program_id, programIds));
  for (const row of rows) {
    const summary = row as unknown as CampaignSummaryRollupRow;
    out.set(summary.program_id, summary);
  }
  return out;
}
