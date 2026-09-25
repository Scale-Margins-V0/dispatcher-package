import { describe, expect, it } from "vitest";
import { BUCKET_COUNT, bucketIndex, quantile } from "./histogram.js";

describe("histogram", () => {
  it("buckets by inclusive upper bound, overflow last", () => {
    expect(bucketIndex(0)).toBe(0);
    expect(bucketIndex(10)).toBe(0);
    expect(bucketIndex(11)).toBe(1);
    expect(bucketIndex(10_001)).toBe(BUCKET_COUNT - 1);
  });

  it("interpolates a quantile inside its bucket, capped at the observed max", () => {
    const b = new Array(BUCKET_COUNT).fill(0);
    b[bucketIndex(80)] = 100; // 100 samples in (50, 100]
    expect(quantile(b, 0.5, 100)).toBe(75);
    expect(quantile(b, 0.99, 90)).toBe(90);
    expect(quantile(new Array(BUCKET_COUNT).fill(0), 0.5, null)).toBeNull();
  });
});
