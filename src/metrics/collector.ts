/**
 * Performance metrics for the send path, rolled up per minute.
 *
 *   recordMetric(scope, "api_call", "user_info", { ok: 1, ms: 182 })
 *
 * Samples aggregate in memory by (minute, program, step, kind, subject) and
 * are inserted once a minute — the send path never waits on a metrics write.
 * Each flush INSERTS its own rows (no upsert); reads SUM them, so a minute
 * split across two flushes, or written by two replicas, still adds up.
 *
 * Kinds (see MetricKind):
 *   dispatch         one per dispatch run; items = recipients, ms = run time
 *   lookup           the user lookup; subject = backend, items = ids asked,
 *                    skipped = ids not found
 *   api_call         one per HTTP request an api variable made; subject =
 *                    variable. Recipient rows (count 0): items = recipients
 *                    served, fallback = got the fallback, skipped = call
 *                    skipped (required call metadata missing)
 *   query_var        the same for SQL variables
 *   message_resolve  per message: dispatch start → content ready; failed =
 *                    could not be built (no user / no sender)
 *   provider_send    per message: provider latency incl. failover; subject = provider
 *   message_e2e      per sent message: dispatch start → provider accepted
 *
 * Never throws into the caller, and memory is capped: past MAX_GROUPS new
 * groups are dropped until the next flush.
 */

import { randomUUID } from "node:crypto";
import { getDb, isDbInitialized } from "../db/client.js";
import { queryDb, tableFor } from "../db/dialect-helpers.js";
import type { MetricKind } from "../db/schema/index.js";
import { componentLogger } from "../logging/logger.js";
import { BUCKET_COUNT, bucketIndex } from "./histogram.js";

const log = componentLogger("metrics.collector");

const FLUSH_INTERVAL_MS = 60_000;
const MAX_GROUPS = 20_000;
const INSERT_CHUNK = 200;
const MAX_ID = 191;

export type MetricScope = { program_id: string; step_id?: string | null };

/** Increments. `count` defaults to 1; pass 0 for a counters-only sample. */
export type MetricSample = {
  count?: number;
  ok?: number;
  failed?: number;
  timeout?: number;
  skipped?: number;
  fallback?: number;
  items?: number;
  /** A latency observation — adds to sum/min/max and the histogram. */
  ms?: number;
};

type Group = {
  minute: number;
  program_id: string;
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
  buckets: number[];
  /** epoch second → count, for peak_per_sec. At most 60 entries per minute. */
  perSecond: Map<number, number>;
};

let groups = new Map<string, Group>();
let droppedWarned = false;

export function recordMetric(
  scope: MetricScope,
  kind: MetricKind,
  subject: string,
  sample: MetricSample,
  now: number = Date.now()
): void {
  try {
    if (!isDbInitialized() || !scope.program_id) return;
    const minute = Math.floor(now / 60_000);
    const program_id = scope.program_id.slice(0, MAX_ID);
    const step_id = (scope.step_id ?? "").slice(0, MAX_ID);
    const name = subject.slice(0, MAX_ID);
    const key = `${minute}\u0000${program_id}\u0000${step_id}\u0000${kind}\u0000${name}`;
    let g = groups.get(key);
    if (!g) {
      if (groups.size >= MAX_GROUPS) {
        if (!droppedWarned) {
          droppedWarned = true;
          log.warn({ max_groups: MAX_GROUPS }, "Metrics buffer full — dropping samples until the next flush");
        }
        return;
      }
      g = {
        minute,
        program_id,
        step_id,
        kind,
        subject: name,
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
        buckets: new Array<number>(BUCKET_COUNT).fill(0),
        perSecond: new Map(),
      };
      groups.set(key, g);
    }
    const count = sample.count ?? 1;
    g.count += count;
    g.ok += sample.ok ?? 0;
    g.failed += sample.failed ?? 0;
    g.timeout += sample.timeout ?? 0;
    g.skipped += sample.skipped ?? 0;
    g.fallback += sample.fallback ?? 0;
    g.items += sample.items ?? 0;
    if (count > 0) {
      const second = Math.floor(now / 1000);
      g.perSecond.set(second, (g.perSecond.get(second) ?? 0) + count);
    }
    if (typeof sample.ms === "number" && Number.isFinite(sample.ms)) {
      const ms = Math.max(0, Math.round(sample.ms));
      g.sum_ms += ms;
      g.min_ms = g.min_ms === null ? ms : Math.min(g.min_ms, ms);
      g.max_ms = g.max_ms === null ? ms : Math.max(g.max_ms, ms);
      g.buckets[bucketIndex(ms)]! += 1;
    }
  } catch {
    // Metrics are best-effort; a send must never fail because of them.
  }
}

function toRow(g: Group): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: randomUUID(),
    minute: g.minute,
    program_id: g.program_id,
    step_id: g.step_id,
    kind: g.kind,
    subject: g.subject,
    count: g.count,
    ok: g.ok,
    failed: g.failed,
    timeout: g.timeout,
    skipped: g.skipped,
    fallback: g.fallback,
    items: g.items,
    sum_ms: g.sum_ms,
    min_ms: g.min_ms,
    max_ms: g.max_ms,
    peak_per_sec: Math.max(0, ...g.perSecond.values()),
  };
  g.buckets.forEach((n, i) => {
    row[`b${i}`] = n;
  });
  return row;
}

/** Write everything buffered so far. Failed writes are dropped, not retried. */
export async function flushMetrics(): Promise<void> {
  if (groups.size === 0) return;
  const batch = [...groups.values()];
  groups = new Map();
  droppedWarned = false;
  if (!isDbInitialized()) return;
  const dbx = getDb();
  const table = tableFor(dbx, "dispatchMetrics");
  try {
    for (let i = 0; i < batch.length; i += INSERT_CHUNK) {
      await queryDb(dbx).insert(table).values(batch.slice(i, i + INSERT_CHUNK).map(toRow));
    }
  } catch (error) {
    log.warn(
      { err: error instanceof Error ? error : new Error(String(error)), rows: batch.length },
      "Metrics flush failed — this minute's samples are dropped"
    );
  }
}

let timer: NodeJS.Timeout | null = null;

export function startMetricsFlush(): void {
  if (process.env.VITEST === "true" || timer) return;
  timer = setInterval(() => void flushMetrics(), FLUSH_INTERVAL_MS);
  timer.unref();
}

export function resetMetricsForTests(): void {
  groups = new Map();
  droppedWarned = false;
}
