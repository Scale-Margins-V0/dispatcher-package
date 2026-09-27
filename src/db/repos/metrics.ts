/**
 * Reads over dispatch_metrics. Every query is bounded: a window of at most 7
 * days (one program, or all of them), grouped server-side — never a scan
 * returned row by row.
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
    group: String(r.group ?? ""),
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
  /** Omitted = every program (the overall view). */
  programId?: string;
  fromMinute: number;
  toMinute: number;
  /** Bucket size in minutes — from a fixed whitelist, never user text. */
  resolution: number;
  stepId?: string;
};

function scope(t: any, w: MetricsWindow) {
  return and(
    w.programId !== undefined ? eq(t.program_id, w.programId) : undefined,
    gte(t.minute, w.fromMinute),
    lte(t.minute, w.toMinute)
  );
}

/** Sums per (bucket, kind, subject) — the timeline, totals and per-variable data. */
export async function sumMetrics(w: MetricsWindow): Promise<SummedRow[]> {
  const dbx = getDb();
  const t = tableFor(dbx, "dispatchMetrics");
  const res = Math.max(1, Math.trunc(w.resolution));
  // A literal, not a bind parameter: postgres cannot type `integer % $1`.
  const bucket = sql`${t.minute} - (${t.minute} % ${sql.raw(String(res))})`;
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .select({ bucket, kind: t.kind, subject: t.subject, ...sums(t) })
    .from(t)
    .where(and(scope(t, w), w.stepId !== undefined ? eq(t.step_id, w.stepId) : undefined))
    .groupBy(bucket, t.kind, t.subject);
  return rows.map(toSummed);
}

/**
 * Sums per (group, kind) over the window: per step inside one program, per
 * program across all of them. Ignores `stepId` so the step table can switch.
 */
export async function sumMetricsBy(w: MetricsWindow, by: "step_id" | "program_id"): Promise<SummedRow[]> {
  const dbx = getDb();
  const t = tableFor(dbx, "dispatchMetrics");
  const rows: Record<string, unknown>[] = await queryDb(dbx)
    .select({ group: t[by], kind: t.kind, ...sums(t) })
    .from(t)
    .where(scope(t, w))
    .groupBy(t[by], t.kind);
  return rows.map(toSummed);
}
