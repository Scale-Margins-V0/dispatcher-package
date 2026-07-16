/**
 * Persisted per-recipient lifecycle events (PII-stripped) powering the admin
 * campaign console: funnels, per-user stage rollups, and event timelines.
 *
 * Cross-dialect rules (sqlite/mysql/pg):
 * - drizzle operators for every filter/cursor — raw sql`` skips the column
 *   encoder and breaks Date params on sqlite;
 * - sql.param(value, column) for params inside HAVING fragments;
 * - .mapWith(column) so aggregate timestamps decode back to Date;
 * - aggregate counts wrapped in num() (pg returns bigint/numeric as strings);
 * - json/timestamp columns projected as columns, never through sql``.
 */

import { and, asc, desc, eq, inArray, isNotNull, like, lt, or, sql } from "drizzle-orm";
import { getDb } from "../client.js";
import { insertIgnore, queryDb, tableFor } from "../dialect-helpers.js";
import type { CampaignEventRow, ProgramKind } from "../schema/index.js";

const num = (value: unknown): number => Number(value ?? 0);
const escLike = (value: string): string => value.replaceAll("%", "\\%");

const INSERT_CHUNK = 200;

export async function insertCampaignEvents(rows: CampaignEventRow[]): Promise<void> {
  if (rows.length === 0) return;
  const dbx = getDb();
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await insertIgnore(
      dbx,
      "campaignEvents",
      rows.slice(i, i + INSERT_CHUNK) as unknown as Record<string, unknown>[],
      ["dedupe_key"]
    );
  }
}

const toEvent = (raw: Record<string, unknown>): CampaignEventRow =>
  raw as unknown as CampaignEventRow;

export type CampaignEventPage = {
  events: CampaignEventRow[];
  next_cursor: { ts: Date; id: string } | null;
};

export async function listCampaignEvents(options: {
  program_id: string;
  step_id?: string;
  event?: string;
  user_id?: string;
  q?: string;
  cursor?: { ts: Date; id: string };
  limit: number;
}): Promise<CampaignEventPage> {
  const dbx = getDb();
  const t = tableFor(dbx, "campaignEvents");
  const conditions: unknown[] = [eq(t.program_id, options.program_id)];
  if (options.step_id) conditions.push(eq(t.step_id, options.step_id));
  if (options.event) conditions.push(eq(t.event, options.event));
  if (options.user_id) conditions.push(eq(t.user_id, options.user_id));
  if (options.q) {
    const needle = `%${escLike(options.q)}%`;
    conditions.push(sql`(${like(t.user_id, needle)} or ${like(t.provider_message_id, needle)})`);
  }
  if (options.cursor) {
    conditions.push(
      or(
        lt(t.occurred_at, options.cursor.ts),
        and(eq(t.occurred_at, options.cursor.ts), lt(t.id, options.cursor.id))
      )
    );
  }
  const raw: Record<string, unknown>[] = await queryDb(dbx)
    .select()
    .from(t)
    .where(and(...(conditions as never[])))
    .orderBy(desc(t.occurred_at), desc(t.id))
    .limit(options.limit + 1);
  const rows = raw.map(toEvent);
  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  const last = page[page.length - 1];
  return {
    events: page,
    next_cursor: hasMore && last ? { ts: last.occurred_at, id: last.id } : null,
  };
}

/** Full chronological journey of one recipient in one campaign. */
export async function listUserTimeline(
  program_id: string,
  user_id: string,
  limit = 200
): Promise<CampaignEventRow[]> {
  const dbx = getDb();
  const t = tableFor(dbx, "campaignEvents");
  const raw: Record<string, unknown>[] = await queryDb(dbx)
    .select()
    .from(t)
    .where(and(eq(t.program_id, program_id), eq(t.user_id, user_id)))
    .orderBy(asc(t.occurred_at), asc(t.id))
    .limit(limit);
  return raw.map(toEvent);
}

// ---------------------------------------------------------------------------
// Funnel + rollups
// ---------------------------------------------------------------------------

/**
 * Stages are kept in each channel's own vocabulary — `read` is NOT folded into
 * `opened`. They are different signals with different trust: an email open is a
 * tracking pixel (inflated by Apple MPP prefetch, suppressed by blocked
 * images), a WhatsApp read is a delivery receipt the recipient can disable.
 * SMS has no view signal at all. Callers pick the labels per channel; the store
 * never averages them together. This matches ScaleMargin's own canonicalizer,
 * which deliberately preserves `read` as distinct.
 */
const STAGE_EVENTS: Record<string, string[]> = {
  dispatched: ["dispatched"],
  delivered: ["delivered"],
  opened: ["opened"],
  read: ["read"],
  clicked: ["clicked"],
  bounced: ["bounced"],
  complained: ["complained"],
  unsubscribed: ["unsubscribed"],
  failed: ["failed"],
};

export type CampaignFunnel = {
  unique_recipients: number;
  dispatched: number;
  delivered: number;
  /** Email/push tracking-pixel opens. */
  opened: number;
  /** WhatsApp read receipts — counted separately from opens, never merged. */
  read: number;
  clicked: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  failed: number;
};

const EMPTY_FUNNEL: CampaignFunnel = {
  unique_recipients: 0,
  dispatched: 0,
  delivered: 0,
  opened: 0,
  read: 0,
  clicked: 0,
  bounced: 0,
  complained: 0,
  unsubscribed: 0,
  failed: 0,
};

/** `count(distinct case when event in (…) then user_id end)` — portable across all three dialects. */
const distinctUsersIf = (t: any, events: string[]) =>
  sql`count(distinct case when ${t.event} in (${sql.join(
    events.map((event) => sql`${event}`),
    sql`, `
  )}) then ${t.user_id} end)`;

function funnelProjection(t: any): Record<string, unknown> {
  const projection: Record<string, unknown> = {
    unique_recipients: sql`count(distinct ${t.user_id})`,
  };
  for (const [stage, events] of Object.entries(STAGE_EVENTS)) {
    projection[stage] = distinctUsersIf(t, events);
  }
  return projection;
}

function rowToFunnel(row: Record<string, unknown> | undefined): CampaignFunnel {
  if (!row) return { ...EMPTY_FUNNEL };
  const funnel = { ...EMPTY_FUNNEL };
  for (const key of Object.keys(funnel) as Array<keyof CampaignFunnel>) {
    funnel[key] = num(row[key]);
  }
  return funnel;
}

export async function getCampaignFunnel(
  program_id: string,
  step_id?: string
): Promise<CampaignFunnel> {
  const dbx = getDb();
  const t = tableFor(dbx, "campaignEvents");
  const where = [eq(t.program_id, program_id)];
  if (step_id) where.push(eq(t.step_id, step_id));
  const [row]: Record<string, unknown>[] = await queryDb(dbx)
    .select(funnelProjection(t))
    .from(t)
    .where(and(...(where as never[])));
  return rowToFunnel(row);
}

/** Per-campaign funnels for a page of campaign ids (hub engagement column). */
export async function getCampaignEventAggregates(
  programIds: string[]
): Promise<Map<string, CampaignFunnel>> {
  if (programIds.length === 0) return new Map();
  const dbx = getDb();
  const t = tableFor(dbx, "campaignEvents");
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .select({ program_id: t.program_id, ...funnelProjection(t) })
    .from(t)
    .where(inArray(t.program_id, programIds))
    .groupBy(t.program_id);
  return new Map(rows.map((row) => [String(row.program_id), rowToFunnel(row)]));
}

// ---------------------------------------------------------------------------
// Recipient rollup — one row per user with stage flags + derived status
// ---------------------------------------------------------------------------

/**
 * Ordered worst-signal-first; the first raised flag names the recipient status.
 * `opened` and `read` are the same rung on different channels — a recipient can
 * only hold both via a mixed-channel drip, where `opened` wins and is still true.
 */
export const RECIPIENT_STATUS_ORDER = [
  "complained",
  "bounced",
  "failed",
  "unsubscribed",
  "clicked",
  "opened",
  "read",
  "delivered",
  "dispatched",
] as const;

export type RecipientStatus = (typeof RECIPIENT_STATUS_ORDER)[number] | "pending";

export type RecipientRollupRow = {
  user_id: string;
  dispatched: boolean;
  delivered: boolean;
  opened: boolean;
  read: boolean;
  clicked: boolean;
  bounced: boolean;
  complained: boolean;
  unsubscribed: boolean;
  failed: boolean;
  event_count: number;
  first_event_at: Date;
  last_event_at: Date;
  status: RecipientStatus;
  /** Distinct drip steps this recipient was touched by; 0 for one-shot campaigns. */
  steps: number;
  /** Distinct channels reached on — >1 means a mixed-channel drip journey. */
  channel_count: number;
};

export function deriveRecipientStatus(flags: Record<string, boolean>): RecipientStatus {
  for (const status of RECIPIENT_STATUS_ORDER) {
    if (flags[status]) return status;
  }
  return "pending";
}

/** `max(case when event in (…) then 1 else 0 end)` flag fragment (string params only — portable). */
const flagIf = (t: any, events: string[]) =>
  sql`max(case when ${t.event} in (${sql.join(
    events.map((event) => sql`${event}`),
    sql`, `
  )}) then 1 else 0 end)`;

function rollupProjection(t: any): Record<string, unknown> {
  // Explicit .as() aliases so the fragments stay referenceable when this
  // projection backs a subquery (drizzle requires aliases on SQL fields there).
  const projection: Record<string, unknown> = { user_id: t.user_id };
  for (const [stage, events] of Object.entries(STAGE_EVENTS)) {
    projection[stage] = flagIf(t, events).as(stage);
  }
  projection.event_count = sql`count(*)`.as("event_count");
  // A drip journey spans steps and can change channel between them.
  projection.steps = sql`count(distinct ${t.step_id})`.as("steps");
  projection.channel_count = sql`count(distinct ${t.channel})`.as("channel_count");
  projection.first_event_at = sql`min(${t.occurred_at})`.mapWith(t.occurred_at).as("first_event_at");
  projection.last_event_at = sql`max(${t.occurred_at})`.mapWith(t.occurred_at).as("last_event_at");
  return projection;
}

/**
 * HAVING fragment selecting exactly the users whose derived status equals
 * `status`: every higher-precedence flag is 0 and the status flag itself is 1
 * (for "pending": all flags 0 — reachable via exotic-only events like deferred).
 */
function statusHaving(t: any, status: RecipientStatus): ReturnType<typeof sql> {
  const parts: ReturnType<typeof sql>[] = [];
  for (const candidate of RECIPIENT_STATUS_ORDER) {
    if (candidate === status) {
      parts.push(sql`${flagIf(t, STAGE_EVENTS[candidate])} = 1`);
      return sql.join(parts, sql` and `);
    }
    parts.push(sql`${flagIf(t, STAGE_EVENTS[candidate])} = 0`);
  }
  // status === "pending": everything above already pushed `= 0`.
  return sql.join(parts, sql` and `);
}

export type RecipientRollupPage = {
  recipients: RecipientRollupRow[];
  next_cursor: { ts: Date; user_id: string } | null;
};

export async function listRecipientRollup(options: {
  program_id: string;
  status?: RecipientStatus;
  q?: string;
  cursor?: { ts: Date; user_id: string };
  limit: number;
}): Promise<RecipientRollupPage> {
  const dbx = getDb();
  const q = queryDb(dbx);
  const t = tableFor(dbx, "campaignEvents");

  const where = [eq(t.program_id, options.program_id)];
  if (options.q) where.push(like(t.user_id, `%${escLike(options.q)}%`));

  const having: ReturnType<typeof sql>[] = [];
  if (options.status) having.push(statusHaving(t, options.status));
  if (options.cursor) {
    const ts = sql.param(options.cursor.ts, t.occurred_at);
    having.push(
      sql`(max(${t.occurred_at}) < ${ts} or (max(${t.occurred_at}) = ${ts} and ${t.user_id} < ${options.cursor.user_id}))`
    );
  }

  let builder = q
    .select(rollupProjection(t))
    .from(t)
    .where(and(...(where as never[])))
    .groupBy(t.user_id);
  if (having.length > 0) builder = builder.having(sql.join(having, sql` and `));
  const raw: Record<string, unknown>[] = await builder
    .orderBy(desc(sql`max(${t.occurred_at})`), desc(t.user_id))
    .limit(options.limit + 1);

  const rows: RecipientRollupRow[] = raw.map((row) => {
    const flags: Record<string, boolean> = {};
    for (const stage of Object.keys(STAGE_EVENTS)) flags[stage] = num(row[stage]) === 1;
    return {
      user_id: String(row.user_id),
      dispatched: flags.dispatched,
      delivered: flags.delivered,
      opened: flags.opened,
      read: flags.read,
      clicked: flags.clicked,
      bounced: flags.bounced,
      complained: flags.complained,
      unsubscribed: flags.unsubscribed,
      failed: flags.failed,
      event_count: num(row.event_count),
      steps: num(row.steps),
      channel_count: num(row.channel_count),
      first_event_at: row.first_event_at as Date,
      last_event_at: row.last_event_at as Date,
      status: deriveRecipientStatus(flags),
    };
  });

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  const last = page[page.length - 1];
  return {
    recipients: page,
    next_cursor: hasMore && last ? { ts: last.last_event_at, user_id: last.user_id } : null,
  };
}

/** Disjoint per-status recipient counts (chip labels); one pass over a per-user subquery. */
export async function getRecipientStatusCounts(
  program_id: string
): Promise<Record<RecipientStatus, number>> {
  const dbx = getDb();
  const q = queryDb(dbx);
  const t = tableFor(dbx, "campaignEvents");

  const inner: any = q
    .select(rollupProjection(t))
    .from(t)
    .where(eq(t.program_id, program_id))
    .groupBy(t.user_id)
    .as("r");

  // Cascade mirrors deriveRecipientStatus: a user counts for the FIRST raised
  // flag. Subquery fields are referenced through drizzle (`inner.<flag>`) so
  // identifier quoting stays dialect-correct (backticks on MySQL).
  const projection: Record<string, unknown> = {};
  const priors: string[] = [];
  for (const status of RECIPIENT_STATUS_ORDER) {
    const zeroes = priors.map((prior) => sql`${inner[prior]} = 0`);
    const own = sql`${inner[status]} = 1`;
    projection[status] = sql`sum(case when ${sql.join([...zeroes, own], sql` and `)} then 1 else 0 end)`;
    priors.push(status);
  }
  projection.pending = sql`sum(case when ${sql.join(
    RECIPIENT_STATUS_ORDER.map((status) => sql`${inner[status]} = 0`),
    sql` and `
  )} then 1 else 0 end)`;

  const [row]: Record<string, unknown>[] = await q.select(projection).from(inner);
  const counts = {} as Record<RecipientStatus, number>;
  for (const status of [...RECIPIENT_STATUS_ORDER, "pending"] as RecipientStatus[]) {
    counts[status] = num(row?.[status]);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Campaign list — grouped over dispatch_runs
// ---------------------------------------------------------------------------

export type CampaignSummaryRow = {
  /** The grouping key: drip_sequence_id for drips, campaign_id for blasts. */
  program_id: string;
  program_kind: ProgramKind;
  /** Distinct drip steps in this program; 0 for one-shot campaigns. */
  steps: number;
  /** Distinct wire sends — for a drip this is roughly people x steps. */
  sends: number;
  organization_id: string | null;
  runs: number;
  accepted_runs: number;
  failed_runs: number;
  /**
   * Sum of dispatch_runs.recipient_count. NOTE: a drip fans out one run per
   * lead per step, so for drips this counts SENDS, not people — the headcount
   * is the funnel's unique_recipients. Callers showing "recipients" to a human
   * should prefer that.
   */
  recipients: number;
  sent: number;
  failed: number;
  first_activity: Date;
  last_activity: Date;
};

export type CampaignSummaryPage = {
  campaigns: CampaignSummaryRow[];
  next_cursor: { ts: Date; program_id: string } | null;
};

export async function listCampaignSummaries(options: {
  q?: string;
  cursor?: { ts: Date; program_id: string };
  limit: number;
}): Promise<CampaignSummaryPage> {
  const dbx = getDb();
  const q = queryDb(dbx);
  const runs = tableFor(dbx, "dispatchRuns");

  let builder = q
    .select({
      program_id: runs.program_id,
      program_kind: sql`max(${runs.program_kind})`,
      organization_id: sql`max(${runs.organization_id})`,
      runs: sql`count(*)`,
      // A drip sends one run per (recipient x step); count the distinct steps
      // and sends so the hub can say "5 steps" instead of "5,000 campaigns".
      steps: sql`count(distinct ${runs.step_id})`,
      sends: sql`count(distinct ${runs.campaign_id})`,
      accepted_runs: sql`sum(case when ${runs.status} = 'accepted' then 1 else 0 end)`,
      failed_runs: sql`sum(case when ${runs.status} = 'failed' then 1 else 0 end)`,
      recipients: sql`coalesce(sum(${runs.recipient_count}), 0)`,
      sent: sql`coalesce(sum(${runs.sent_count}), 0)`,
      failed: sql`coalesce(sum(${runs.failed_count}), 0)`,
      first_activity: sql`min(${runs.occurred_at})`.mapWith(runs.occurred_at),
      last_activity: sql`max(${runs.occurred_at})`.mapWith(runs.occurred_at),
    })
    .from(runs);
  if (options.q) builder = builder.where(like(runs.program_id, `%${escLike(options.q)}%`));
  builder = builder.groupBy(runs.program_id);
  if (options.cursor) {
    const ts = sql.param(options.cursor.ts, runs.occurred_at);
    builder = builder.having(
      sql`(max(${runs.occurred_at}) < ${ts} or (max(${runs.occurred_at}) = ${ts} and ${runs.program_id} < ${options.cursor.program_id}))`
    );
  }
  const raw: Record<string, unknown>[] = await builder
    .orderBy(desc(sql`max(${runs.occurred_at})`), desc(runs.program_id))
    .limit(options.limit + 1);

  const rows: CampaignSummaryRow[] = raw.map((row) => ({
    program_id: String(row.program_id),
    program_kind: (row.program_kind === "drip" ? "drip" : "campaign") as ProgramKind,
    steps: num(row.steps),
    sends: num(row.sends),
    organization_id: row.organization_id === null ? null : String(row.organization_id),
    runs: num(row.runs),
    accepted_runs: num(row.accepted_runs),
    failed_runs: num(row.failed_runs),
    recipients: num(row.recipients),
    sent: num(row.sent),
    failed: num(row.failed),
    first_activity: row.first_activity as Date,
    last_activity: row.last_activity as Date,
  }));

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  const last = page[page.length - 1];
  return {
    campaigns: page,
    next_cursor:
      hasMore && last ? { ts: last.last_activity, program_id: last.program_id } : null,
  };
}

/** Aggregates for exactly one campaign (detail header); null when it has no runs. */
export async function getCampaignRunSummary(
  program_id: string
): Promise<CampaignSummaryRow | null> {
  const dbx = getDb();
  const runs = tableFor(dbx, "dispatchRuns");
  const raw: Record<string, unknown>[] = await queryDb(dbx)
    .select({
      program_id: runs.program_id,
      program_kind: sql`max(${runs.program_kind})`,
      steps: sql`count(distinct ${runs.step_id})`,
      sends: sql`count(distinct ${runs.campaign_id})`,
      organization_id: sql`max(${runs.organization_id})`,
      runs: sql`count(*)`,
      accepted_runs: sql`sum(case when ${runs.status} = 'accepted' then 1 else 0 end)`,
      failed_runs: sql`sum(case when ${runs.status} = 'failed' then 1 else 0 end)`,
      recipients: sql`coalesce(sum(${runs.recipient_count}), 0)`,
      sent: sql`coalesce(sum(${runs.sent_count}), 0)`,
      failed: sql`coalesce(sum(${runs.failed_count}), 0)`,
      first_activity: sql`min(${runs.occurred_at})`.mapWith(runs.occurred_at),
      last_activity: sql`max(${runs.occurred_at})`.mapWith(runs.occurred_at),
    })
    .from(runs)
    .where(eq(runs.program_id, program_id))
    .groupBy(runs.program_id);
  const row = raw[0];
  if (!row) return null;
  return {
    program_id: String(row.program_id),
    program_kind: (row.program_kind === "drip" ? "drip" : "campaign") as ProgramKind,
    steps: num(row.steps),
    sends: num(row.sends),
    organization_id: row.organization_id === null ? null : String(row.organization_id),
    runs: num(row.runs),
    accepted_runs: num(row.accepted_runs),
    failed_runs: num(row.failed_runs),
    recipients: num(row.recipients),
    sent: num(row.sent),
    failed: num(row.failed),
    first_activity: row.first_activity as Date,
    last_activity: row.last_activity as Date,
  };
}

/** Per-step rollup for a drip program: the step list with its own funnel. */
export type ProgramStepRow = {
  step_id: string;
  channel: string;
  provider: string;
  sends: number;
  first_activity: Date;
  last_activity: Date;
};

export async function listProgramSteps(program_id: string): Promise<ProgramStepRow[]> {
  const dbx = getDb();
  const runs = tableFor(dbx, "dispatchRuns");
  const raw: Record<string, unknown>[] = await queryDb(dbx)
    .select({
      step_id: runs.step_id,
      channel: runs.channel,
      provider: runs.provider,
      sends: sql`count(distinct ${runs.campaign_id})`,
      first_activity: sql`min(${runs.occurred_at})`.mapWith(runs.occurred_at),
      last_activity: sql`max(${runs.occurred_at})`.mapWith(runs.occurred_at),
    })
    .from(runs)
    .where(and(eq(runs.program_id, program_id), isNotNull(runs.step_id)))
    .groupBy(runs.step_id, runs.channel, runs.provider)
    .orderBy(asc(sql`min(${runs.occurred_at})`));
  return raw.map((row) => ({
    step_id: String(row.step_id),
    channel: String(row.channel),
    provider: String(row.provider),
    sends: num(row.sends),
    first_activity: row.first_activity as Date,
    last_activity: row.last_activity as Date,
  }));
}

/** Distinct channel/provider pairs per campaign for a page of ids. */
export async function listCampaignChannels(
  programIds: string[]
): Promise<Array<{ program_id: string; channel: string; provider: string }>> {
  if (programIds.length === 0) return [];
  const dbx = getDb();
  const runs = tableFor(dbx, "dispatchRuns");
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .select({ program_id: runs.program_id, channel: runs.channel, provider: runs.provider })
    .from(runs)
    .where(inArray(runs.program_id, programIds))
    .groupBy(runs.program_id, runs.channel, runs.provider);
  return rows.map((row) => ({
    program_id: String(row.program_id),
    channel: String(row.channel),
    provider: String(row.provider),
  }));
}
