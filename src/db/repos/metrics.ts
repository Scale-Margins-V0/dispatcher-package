/**
 * Reads over dispatch_metrics. Every query is bounded: one program, a window of
 * at most 7 days, grouped server-side — never a scan returned row by row.
 */

import { and, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "../client.js";
import { queryDb, tableFor } from "../dialect-helpers.js";
import type { MetricKind } from "../schema/index.js";
import { BUCKET_COUNT } from "../../metrics/histogram.js";
import type { SummedRow } from "../../metrics/report.js";

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function sums(t: any) {
  const out: Record<string, unknown> = {
    count: sql`coalesce(sum(${t.count}), 0)`,
    ok: sql`coalesce(sum(${t.ok}), 0)`,
    failed: sql`coalesce(sum(${t.failed}), 0)`,
    timeout: sql`coalesce(sum(${t.timeout}), 0)`,
    skipped: sql`coalesce(sum(${t.skipped}), 0)`,
    fallback: sql`coalesce(sum(${t.fallback}), 0)`,
    items: sql`coalesce(sum(${t.items}), 0)`,
    sum_ms: sql`coalesce(sum(${t.sum_ms}), 0)`,
    min_ms: sql`min(${t.min_ms})`,
    max_ms: sql`max(${t.max_ms})`,
    peak_per_sec: sql`coalesce(max(${t.peak_per_sec}), 0)`,
  };
  for (let i = 0; i < BUCKET_COUNT; i++) out[`b${i}`] = sql`coalesce(sum(${t[`b${i}`]}), 0)`;
  return out;
}

function toSummed(r: Record<string, unknown>): SummedRow {
  return {
    bucket: num(r.bucket),
    step_id: String(r.step_id ?? ""),
    kind: r.kind as MetricKind,
    subject: String(r.subject ?? ""),
    count: num(r.count),
    ok: num(r.ok),
    failed: num(r.failed),
    timeout: num(r.timeout),
    skipped: num(r.skipped),
    fallback: num(r.fallback),
    items: num(r.items),
    sum_ms: num(r.sum_ms),
    min_ms: numOrNull(r.min_ms),
    max_ms: numOrNull(r.max_ms),
    peak_per_sec: num(r.peak_per_sec),
    buckets: Array.from({ length: BUCKET_COUNT }, (_, i) => num(r[`b${i}`])),
  };
}

export type MetricsWindow = {
  programId: string;
  fromMinute: number;
  toMinute: number;
  /** Bucket size in minutes — from a fixed whitelist, never user text. */
  resolution: number;
  stepId?: string;
};

/** Sums per (bucket, kind, subject) — the timeline, totals and per-variable data. */
export async function sumProgramMetrics(w: MetricsWindow): Promise<SummedRow[]> {
  const dbx = getDb();
  const t = tableFor(dbx, "dispatchMetrics");
  const res = Math.max(1, Math.trunc(w.resolution));
  // A literal, not a bind parameter: postgres cannot type `integer % $1`.
  const bucket = sql`${t.minute} - (${t.minute} % ${sql.raw(String(res))})`;
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .select({ bucket, kind: t.kind, subject: t.subject, ...sums(t) })
    .from(t)
    .where(
      and(
        eq(t.program_id, w.programId),
        gte(t.minute, w.fromMinute),
        lte(t.minute, w.toMinute),
        w.stepId !== undefined ? eq(t.step_id, w.stepId) : undefined
      )
    )
    .groupBy(bucket, t.kind, t.subject);
  return rows.map(toSummed);
}

/** Sums per (step, kind) over the window — the per-step table. */
export async function sumProgramMetricsBySteps(w: MetricsWindow): Promise<SummedRow[]> {
  const dbx = getDb();
  const t = tableFor(dbx, "dispatchMetrics");
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .select({ step_id: t.step_id, kind: t.kind, ...sums(t) })
    .from(t)
    .where(and(eq(t.program_id, w.programId), gte(t.minute, w.fromMinute), lte(t.minute, w.toMinute)))
    .groupBy(t.step_id, t.kind);
  return rows.map(toSummed);
}
