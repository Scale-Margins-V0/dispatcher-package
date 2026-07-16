import { and, desc, eq, gt, gte, lt, ne, or, sql } from "drizzle-orm";
import { getDb } from "../client.js";
import { queryDb, tableFor, upsert } from "../dialect-helpers.js";
import type {
  DispatchRunRow,
  RecipientFailureRow,
  WebhookActivityRow,
} from "../schema/index.js";

const num = (value: unknown): number => Number(value ?? 0);

export async function upsertDispatchRun(
  run: Omit<DispatchRunRow, "updated_at">
): Promise<void> {
  const now = new Date();
  const values = { ...run, updated_at: now };
  const { id: _id, ...updateSet } = values;
  await upsert(getDb(), "dispatchRuns", values, ["id"], updateSet);
}

export async function insertRecipientFailure(row: RecipientFailureRow): Promise<void> {
  const dbx = getDb();
  await queryDb(dbx).insert(tableFor(dbx, "dispatchRecipientFailures")).values(row);
}

export async function insertWebhookActivity(row: WebhookActivityRow): Promise<void> {
  const dbx = getDb();
  await queryDb(dbx).insert(tableFor(dbx, "webhookActivity")).values(row);
}

export type ActivitySnapshot = {
  summary: {
    accepted_dispatches: number;
    completed_dispatches: number;
    sent: number;
    failed: number;
    webhook_success_rate: number | null;
  };
  dispatches: DispatchRunRow[];
  webhooks: WebhookActivityRow[];
  failures: Array<DispatchRunRow | WebhookActivityRow>;
};

function toRun(raw: Record<string, unknown>): DispatchRunRow {
  return raw as unknown as DispatchRunRow;
}

function toWebhook(raw: Record<string, unknown>): WebhookActivityRow {
  return raw as unknown as WebhookActivityRow;
}

export async function getActivitySnapshot(limit = 50): Promise<ActivitySnapshot> {
  const dbx = getDb();
  const q = queryDb(dbx);
  const runs = tableFor(dbx, "dispatchRuns");
  const webhooks = tableFor(dbx, "webhookActivity");
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [acceptedRow] = await q.select({ n: sql`count(*)` }).from(runs);
  const [completedRow] = await q
    .select({
      n: sql`count(*)`,
      sent: sql`coalesce(sum(${runs.sent_count}), 0)`,
      failed: sql`coalesce(sum(${runs.failed_count}), 0)`,
    })
    .from(runs)
    .where(eq(runs.status, "completed"));

  const [outboundRow] = await q
    .select({
      total: sql`count(*)`,
      delivered: sql`sum(case when ${webhooks.status} = 'delivered' then 1 else 0 end)`,
    })
    .from(webhooks)
    .where(and(eq(webhooks.direction, "outbound"), gte(webhooks.occurred_at, dayAgo)));

  const latestRuns: Record<string, unknown>[] = await q
    .select()
    .from(runs)
    .orderBy(desc(runs.occurred_at), desc(runs.id))
    .limit(limit);
  const latestWebhooks: Record<string, unknown>[] = await q
    .select()
    .from(webhooks)
    .orderBy(desc(webhooks.occurred_at), desc(webhooks.id))
    .limit(limit);

  const failedRuns: Record<string, unknown>[] = await q
    .select()
    .from(runs)
    .where(or(eq(runs.status, "failed"), gt(runs.failed_count, 0)))
    .orderBy(desc(runs.occurred_at), desc(runs.id))
    .limit(limit);
  const failedWebhooks: Record<string, unknown>[] = await q
    .select()
    .from(webhooks)
    .where(ne(webhooks.status, "delivered"))
    .orderBy(desc(webhooks.occurred_at), desc(webhooks.id))
    .limit(limit);

  const outboundTotal = num(outboundRow?.total);
  return {
    summary: {
      accepted_dispatches: num(acceptedRow?.n),
      completed_dispatches: num(completedRow?.n),
      sent: num(completedRow?.sent),
      failed: num(completedRow?.failed),
      webhook_success_rate: outboundTotal
        ? Math.round((num(outboundRow?.delivered) / outboundTotal) * 1000) / 10
        : null,
    },
    dispatches: latestRuns.map(toRun),
    webhooks: latestWebhooks.map(toWebhook),
    failures: [...failedRuns.map(toRun), ...failedWebhooks.map(toWebhook)].slice(0, limit),
  };
}

export type RunPage = { runs: DispatchRunRow[]; next_cursor: { ts: Date; id: string } | null };

export async function listDispatchRuns(options: {
  campaign_id?: string;
  /** Group key — a drip program's runs span many wire campaign ids. */
  program_id?: string;
  step_id?: string;
  status?: string;
  cursor?: { ts: Date; id: string };
  limit: number;
}): Promise<RunPage> {
  const dbx = getDb();
  const runs = tableFor(dbx, "dispatchRuns");
  const conditions: unknown[] = [];
  if (options.campaign_id) conditions.push(eq(runs.campaign_id, options.campaign_id));
  if (options.program_id) conditions.push(eq(runs.program_id, options.program_id));
  if (options.step_id) conditions.push(eq(runs.step_id, options.step_id));
  if (options.status) conditions.push(eq(runs.status, options.status));
  if (options.cursor) {
    // Drizzle operators, not raw sql`` — raw templates don't run Date params
    // through the column encoder, which breaks on sqlite (ms-integer storage).
    conditions.push(
      or(
        lt(runs.occurred_at, options.cursor.ts),
        and(eq(runs.occurred_at, options.cursor.ts), lt(runs.id, options.cursor.id))
      )
    );
  }
  let builder = queryDb(dbx).select().from(runs);
  if (conditions.length > 0) builder = builder.where(and(...(conditions as never[])));
  const raw: Record<string, unknown>[] = await builder
    .orderBy(desc(runs.occurred_at), desc(runs.id))
    .limit(options.limit + 1);
  const rows = raw.map(toRun);
  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  const last = page[page.length - 1];
  return {
    runs: page,
    next_cursor: hasMore && last ? { ts: last.occurred_at, id: last.id } : null,
  };
}

/** True when the campaign has an in-flight (accepted) run since `since` — drives GUI polling. */
export async function hasActiveRun(program_id: string, since: Date): Promise<boolean> {
  const dbx = getDb();
  const runs = tableFor(dbx, "dispatchRuns");
  const [row] = await queryDb(dbx)
    .select({ n: sql`count(*)` })
    .from(runs)
    .where(
      and(eq(runs.program_id, program_id), eq(runs.status, "accepted"), gte(runs.occurred_at, since))
    );
  return num(row?.n) > 0;
}

/**
 * Send-time failures for one recipient across a whole program. A drip
 * recipient's failures are spread over many wire campaign ids, so we join
 * through the program map rather than enumerating sends.
 */
export async function listRecipientFailuresForUser(
  program_id: string,
  user_id: string,
  limit = 100
): Promise<RecipientFailureRow[]> {
  const dbx = getDb();
  const f = tableFor(dbx, "dispatchRecipientFailures");
  const p = tableFor(dbx, "dispatchPrograms");
  const raw: Record<string, unknown>[] = await queryDb(dbx)
    .select({
      id: f.id,
      dispatch_run_id: f.dispatch_run_id,
      campaign_id: f.campaign_id,
      user_id: f.user_id,
      provider: f.provider,
      error_category: f.error_category,
      error_message: f.error_message,
      error_stack: f.error_stack,
      context: f.context,
      occurred_at: f.occurred_at,
    })
    .from(f)
    // LEFT JOIN + fallback: an unmapped send still shows its failures.
    .leftJoin(p, eq(p.campaign_id, f.campaign_id))
    .where(
      and(
        or(eq(p.program_id, program_id), eq(f.campaign_id, program_id)),
        eq(f.user_id, user_id)
      )
    )
    .orderBy(desc(f.occurred_at), desc(f.id))
    .limit(limit);
  return raw as unknown as RecipientFailureRow[];
}

export async function getDispatchRun(id: string): Promise<{
  run: DispatchRunRow;
  recipient_failures: RecipientFailureRow[];
} | null> {
  const dbx = getDb();
  const q = queryDb(dbx);
  const runs = tableFor(dbx, "dispatchRuns");
  const failures = tableFor(dbx, "dispatchRecipientFailures");
  const raw: Record<string, unknown>[] = await q.select().from(runs).where(eq(runs.id, id));
  if (!raw[0]) return null;
  const failureRows: Record<string, unknown>[] = await q
    .select()
    .from(failures)
    .where(eq(failures.dispatch_run_id, id))
    .orderBy(desc(failures.occurred_at))
    .limit(500);
  return {
    run: toRun(raw[0]),
    recipient_failures: failureRows as unknown as RecipientFailureRow[],
  };
}
