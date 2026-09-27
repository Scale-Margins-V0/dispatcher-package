/**
 * Fixed latency buckets (ms, upper bounds, inclusive); the last bucket is
 * everything above 10s. Fixed — not per-row — so histograms from any rows add
 * up, which is what makes p95 over an hour or a week computable from minutes.
 * Changing these bounds invalidates stored rows; add a column instead.
 */
export const BUCKET_BOUNDS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;
export const BUCKET_COUNT = BUCKET_BOUNDS_MS.length + 1;

export function bucketIndex(ms: number): number {
  const i = BUCKET_BOUNDS_MS.findIndex((bound) => ms <= bound);
  return i === -1 ? BUCKET_BOUNDS_MS.length : i;
}

/**
 * The q-quantile (0..1) of a histogram, interpolated linearly inside the
 * bucket it falls in. `max` caps the open-ended top bucket (and any estimate):
 * a p99 above the slowest request seen would be a lie.
 */
export function quantile(buckets: number[], q: number, max: number | null): number | null {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const rank = q * total;
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) {
    const n = buckets[i] ?? 0;
    if (n > 0 && seen + n >= rank) {
      const lo = i === 0 ? 0 : BUCKET_BOUNDS_MS[i - 1]!;
      const hi = BUCKET_BOUNDS_MS[i] ?? Math.max(max ?? lo, lo);
      const estimate = lo + ((rank - seen) / n) * (hi - lo);
      return Math.round(max === null ? estimate : Math.min(estimate, max));
    }
    seen += n;
  }
  return max;
}
