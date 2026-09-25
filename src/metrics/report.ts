/**
 * Turns summed dispatch_metrics rows into the campaign metrics report
 * (GET /campaigns/:programId/metrics). Pure — the repo does the SQL.
 *
 * Latency percentiles come from the fixed histograms (histogram.ts), so they
 * are estimates within a bucket — exact enough to spot a slow API, never
 * averaged across minutes (which would be wrong).
 */

import type { MetricKind } from "../db/schema/index.js";
import { BUCKET_COUNT, quantile } from "./histogram.js";

export const METRIC_RANGES = {
  "1h": { minutes: 60, resolution: 1 },
  "6h": { minutes: 360, resolution: 5 },
  "24h": { minutes: 1440, resolution: 15 },
  "3d": { minutes: 4320, resolution: 60 },
  "7d": { minutes: 10080, resolution: 120 },
} as const;

export type MetricRange = keyof typeof METRIC_RANGES;

/** Top variables by calls that also get a per-bucket series. */
const VARIABLE_SERIES_LIMIT = 10;
const VARIABLE_LIMIT = 100;

/** One SUM row: a bucket (epoch minute) × kind × subject, or a step × kind. */
export type SummedRow = {
  bucket: number;
  step_id: string;
  kind: MetricKind;
  subject: string;
  count: number;
  ok: number;
  failed: number;
  timeout: number;
  skipped: number;
  fallback: number;
  items: number;
  sum_ms: number;
  min_ms: number | null;
  max_ms: number | null;
  peak_per_sec: number;
  buckets: number[];
};

export type Stat = {
  count: number;
  ok: number;
  failed: number;
  timeout: number;
  skipped: number;
  fallback: number;
  items: number;
  /** (failed + timeout) / count; null when nothing ran. */
  error_rate: number | null;
  avg_ms: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  min_ms: number | null;
  max_ms: number | null;
  peak_per_sec: number;
  /** Mean count per minute over minutes that had activity. */
  per_minute_avg: number | null;
  /** Busiest bucket's count, per minute. */
  per_minute_peak: number | null;
};

type Acc = Omit<SummedRow, "bucket" | "step_id" | "kind" | "subject"> & { activeBuckets: Set<number>; bucketCounts: Map<number, number> };

function emptyAcc(): Acc {
  return {
    count: 0,
    ok: 0,
    failed: 0,
    timeout: 0,
    skipped: 0,
    fallback: 0,
    items: 0,
    sum_ms: 0,
    min_ms: null,
    max_ms: null,
    peak_per_sec: 0,
    buckets: new Array<number>(BUCKET_COUNT).fill(0),
    activeBuckets: new Set(),
    bucketCounts: new Map(),
  };
}

function add(acc: Acc, row: SummedRow): Acc {
  acc.count += row.count;
  acc.ok += row.ok;
  acc.failed += row.failed;
  acc.timeout += row.timeout;
  acc.skipped += row.skipped;
  acc.fallback += row.fallback;
  acc.items += row.items;
  acc.sum_ms += row.sum_ms;
  if (row.min_ms !== null) acc.min_ms = acc.min_ms === null ? row.min_ms : Math.min(acc.min_ms, row.min_ms);
  if (row.max_ms !== null) acc.max_ms = acc.max_ms === null ? row.max_ms : Math.max(acc.max_ms, row.max_ms);
  acc.peak_per_sec = Math.max(acc.peak_per_sec, row.peak_per_sec);
  row.buckets.forEach((n, i) => {
    acc.buckets[i]! += n;
  });
  if (row.count > 0) {
    acc.activeBuckets.add(row.bucket);
    acc.bucketCounts.set(row.bucket, (acc.bucketCounts.get(row.bucket) ?? 0) + row.count);
  }
  return acc;
}

function stat(acc: Acc, resolution: number): Stat {
  const samples = acc.buckets.reduce((a, b) => a + b, 0);
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return {
    count: acc.count,
    ok: acc.ok,
    failed: acc.failed,
    timeout: acc.timeout,
    skipped: acc.skipped,
    fallback: acc.fallback,
    items: acc.items,
    error_rate: acc.count > 0 ? Math.round(((acc.failed + acc.timeout) / acc.count) * 10_000) / 10_000 : null,
    avg_ms: samples > 0 ? Math.round(acc.sum_ms / samples) : null,
    p50_ms: quantile(acc.buckets, 0.5, acc.max_ms),
    p95_ms: quantile(acc.buckets, 0.95, acc.max_ms),
    p99_ms: quantile(acc.buckets, 0.99, acc.max_ms),
    min_ms: acc.min_ms,
    max_ms: acc.max_ms,
    peak_per_sec: acc.peak_per_sec,
    per_minute_avg: acc.activeBuckets.size > 0 ? round1(acc.count / (acc.activeBuckets.size * resolution)) : null,
    per_minute_peak:
      acc.bucketCounts.size > 0 ? round1(Math.max(...acc.bucketCounts.values()) / resolution) : null,
  };
}

function groupBy(rows: SummedRow[], key: (r: SummedRow) => string): Map<string, Acc> {
  const out = new Map<string, Acc>();
  for (const row of rows) {
    const k = key(row);
    out.set(k, add(out.get(k) ?? emptyAcc(), row));
  }
  return out;
}

/** Columns of one timeline point, per kind: calls, failures, avg and p95. */
const TIMELINE_KINDS: Array<[MetricKind, string]> = [
  ["message_resolve", "resolve"],
  ["provider_send", "send"],
  ["message_e2e", "e2e"],
  ["api_call", "api"],
  ["query_var", "query"],
  ["lookup", "lookup"],
];

export type TimelinePoint = { t: string } & Record<string, number | null | string>;

export function buildMetricsReport(args: {
  programId: string;
  range: MetricRange;
  fromMinute: number;
  toMinute: number;
  rows: SummedRow[];
  stepRows: SummedRow[];
  retentionDays: number;
  generatedAt?: Date;
}) {
  const { resolution } = METRIC_RANGES[args.range];
  const { rows } = args;
  const kinds = groupBy(rows, (r) => r.kind);
  const kindStat = (kind: MetricKind) => stat(kinds.get(kind) ?? emptyAcc(), resolution);

  // Dense timeline: every bucket in the window, so charts show gaps as zeros.
  const byBucketKind = groupBy(rows, (r) => `${r.bucket}|${r.kind}`);
  const firstBucket = args.fromMinute - (args.fromMinute % resolution);
  const timeline: TimelinePoint[] = [];
  for (let b = firstBucket; b <= args.toMinute; b += resolution) {
    const point: TimelinePoint = { t: new Date(b * 60_000).toISOString() };
    for (const [kind, prefix] of TIMELINE_KINDS) {
      const acc = byBucketKind.get(`${b}|${kind}`);
      const s = acc ? stat(acc, resolution) : null;
      point[`${prefix}_count`] = s?.count ?? 0;
      point[`${prefix}_ok`] = s?.ok ?? 0;
      point[`${prefix}_failed`] = (s?.failed ?? 0) + (s?.timeout ?? 0);
      point[`${prefix}_avg_ms`] = s?.avg_ms ?? null;
      point[`${prefix}_p95_ms`] = s?.p95_ms ?? null;
    }
    const api = byBucketKind.get(`${b}|api_call`);
    const query = byBucketKind.get(`${b}|query_var`);
    point.api_timeout = api?.timeout ?? 0;
    point.api_peak_per_sec = api?.peak_per_sec ?? 0;
    point.fallbacks = (api?.fallback ?? 0) + (query?.fallback ?? 0);
    timeline.push(point);
  }

  const variableRows = rows.filter((r) => r.kind === "api_call" || r.kind === "query_var");
  const variables = [...groupBy(variableRows, (r) => `${r.kind}|${r.subject}`)]
    .map(([key, acc]) => {
      const [kind, name] = key.split("|") as [MetricKind, string];
      const s = stat(acc, resolution);
      return {
        name,
        source: kind === "api_call" ? ("api" as const) : ("query" as const),
        ...s,
        /** Recipients the variable filled (items) and how many got its fallback. */
        fallback_rate: s.items > 0 ? Math.round((s.fallback / s.items) * 1000) / 1000 : null,
      };
    })
    .sort((a, b) => b.count - a.count || b.items - a.items)
    .slice(0, VARIABLE_LIMIT);

  const seriesFor = new Set(variables.slice(0, VARIABLE_SERIES_LIMIT).map((v) => `${v.source}|${v.name}`));
  const variableSeries = groupBy(
    variableRows.filter((r) => seriesFor.has(`${r.kind === "api_call" ? "api" : "query"}|${r.subject}`)),
    (r) => `${r.kind === "api_call" ? "api" : "query"}|${r.subject}|${r.bucket}`
  );
  const withSeries = variables.map((v) => {
    if (!seriesFor.has(`${v.source}|${v.name}`)) return { ...v, series: null };
    const series = [];
    for (let b = firstBucket; b <= args.toMinute; b += resolution) {
      const acc = variableSeries.get(`${v.source}|${v.name}|${b}`);
      const s = acc ? stat(acc, resolution) : null;
      series.push({
        t: new Date(b * 60_000).toISOString(),
        calls: s?.count ?? 0,
        failed: (s?.failed ?? 0) + (s?.timeout ?? 0),
        avg_ms: s?.avg_ms ?? null,
        p95_ms: s?.p95_ms ?? null,
      });
    }
    return { ...v, series };
  });

  const bySubject = (kind: MetricKind) =>
    [...groupBy(rows.filter((r) => r.kind === kind), (r) => r.subject)]
      .map(([name, acc]) => ({ name, ...stat(acc, resolution) }))
      .sort((a, b) => b.count - a.count);

  const stepKinds = groupBy(args.stepRows, (r) => `${r.step_id}|${r.kind}`);
  const steps = [...new Set(args.stepRows.map((r) => r.step_id))].map((step_id) => {
    const get = (kind: MetricKind) => stat(stepKinds.get(`${step_id}|${kind}`) ?? emptyAcc(), resolution);
    const resolve = get("message_resolve");
    const send = get("provider_send");
    const e2e = get("message_e2e");
    const api = get("api_call");
    return {
      step_id: step_id || null,
      messages: resolve.count,
      resolve_failed: resolve.failed,
      sent: send.ok,
      send_failed: send.failed,
      e2e_p50_ms: e2e.p50_ms,
      e2e_p95_ms: e2e.p95_ms,
      api_calls: api.count,
      api_error_rate: api.error_rate,
    };
  });

  return {
    generated_at: (args.generatedAt ?? new Date()).toISOString(),
    program_id: args.programId,
    window: {
      range: args.range,
      from: new Date(args.fromMinute * 60_000).toISOString(),
      to: new Date((args.toMinute + 1) * 60_000).toISOString(),
      resolution_minutes: resolution,
    },
    retention_days: args.retentionDays,
    has_data: rows.some((r) => r.count > 0 || r.items > 0),
    totals: {
      dispatch: kindStat("dispatch"),
      lookup: kindStat("lookup"),
      api_call: kindStat("api_call"),
      query_var: kindStat("query_var"),
      message_resolve: kindStat("message_resolve"),
      provider_send: kindStat("provider_send"),
      message_e2e: kindStat("message_e2e"),
    },
    timeline,
    variables: withSeries,
    providers: bySubject("provider_send"),
    lookup_modes: bySubject("lookup"),
    steps,
  };
}

export type MetricsReport = ReturnType<typeof buildMetricsReport>;
