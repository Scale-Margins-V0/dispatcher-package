/**
 * Campaign metrics end to end: samples recorded on the send path → flushed to
 * dispatch_metrics → summed and shaped by GET /campaigns/:programId/metrics →
 * pruned by the retention sweep.
 */

import express, { type Express } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatcherDb } from "../../../db/client.js";
import { queryDb, tableFor } from "../../../db/dialect-helpers.js";
import { runRetentionSweep } from "../../../db/retention.js";
import { createTestDb, destroyTestDb } from "../../../db/test-utils.js";
import { flushMetrics, recordMetric, resetMetricsForTests } from "../../../metrics/collector.js";
import { resetDispatchConfigForTests, setDispatchConfigForTests } from "../../../user-lookup/config.js";
import { resolveDynamicValues } from "../../../variables/resolver.js";
import { resetPlaceholdersForTests } from "../../../variables/service.js";
import { ATLAS_KEY_ENV } from "../atlas-key.js";
import { registerApiV1Routes, resetApiRateLimitForTests } from "../router.js";

const KEY = "test-atlas-key-0123456789abcdefghijklmnop";
const BASE = "/api/v1/data-plane/campaigns";
const auth = { Authorization: `Bearer ${KEY}` };
const PROGRAM = { program_id: "seq_1", step_id: "step_a" };

let app: Express;
let dbx: DispatcherDb;
let savedKey: string | undefined;
const api = () => request(app);
const minutesAgo = (n: number) => Date.now() - n * 60_000;

beforeAll(() => {
  savedKey = process.env[ATLAS_KEY_ENV];
  process.env[ATLAS_KEY_ENV] = KEY;
  app = express();
  registerApiV1Routes(app);
});

afterAll(() => {
  if (savedKey === undefined) delete process.env[ATLAS_KEY_ENV];
  else process.env[ATLAS_KEY_ENV] = savedKey;
});

beforeEach(async () => {
  if (dbx) destroyTestDb(dbx);
  dbx = await createTestDb();
  resetMetricsForTests();
  resetApiRateLimitForTests();
});

afterEach(() => {
  resetDispatchConfigForTests();
  vi.restoreAllMocks();
});

describe("GET /campaigns/:programId/metrics", () => {
  it("sums flushed samples into totals, percentiles, a timeline and per-variable rows", async () => {
    for (let i = 0; i < 90; i++) recordMetric(PROGRAM, "api_call", "user_info", { ok: 1, ms: 80 }, minutesAgo(3));
    for (let i = 0; i < 10; i++) recordMetric(PROGRAM, "api_call", "user_info", { timeout: 1, ms: 5000 }, minutesAgo(2));
    recordMetric(PROGRAM, "api_call", "user_info", { count: 0, items: 100, fallback: 10 }, minutesAgo(2));
    recordMetric(PROGRAM, "provider_send", "sendgrid", { ok: 1, ms: 300 }, minutesAgo(2));
    recordMetric({ program_id: "other" }, "api_call", "user_info", { ok: 1, ms: 1 }, minutesAgo(2));
    await flushMetrics();
    // A second flush for the same minute adds up rather than overwriting.
    recordMetric(PROGRAM, "provider_send", "sendgrid", { failed: 1, ms: 900 }, minutesAgo(2));
    await flushMetrics();

    const res = await api().get(`${BASE}/seq_1/metrics?range=1h`).set(auth);
    expect(res.status).toBe(200);
    const m = res.body.metrics;
    expect(m.has_data).toBe(true);
    expect(m.window.resolution_minutes).toBe(1);
    expect(m.timeline).toHaveLength(60);

    const apiTotals = m.totals.api_call;
    expect(apiTotals).toMatchObject({ count: 100, ok: 90, timeout: 10, error_rate: 0.1, max_ms: 5000 });
    expect(apiTotals.p50_ms).toBeGreaterThan(50);
    expect(apiTotals.p50_ms).toBeLessThanOrEqual(100);
    expect(apiTotals.p99_ms).toBeGreaterThan(2500);

    expect(m.variables[0]).toMatchObject({ name: "user_info", source: "api", count: 100, items: 100, fallback_rate: 0.1 });
    expect(m.variables[0].series).toHaveLength(60);
    expect(m.providers[0]).toMatchObject({ name: "sendgrid", count: 2, ok: 1, failed: 1 });
    expect(m.steps).toEqual([expect.objectContaining({ step_id: "step_a", sent: 1, send_failed: 1, api_calls: 100 })]);
    // "other" never leaks into seq_1.
    expect(m.timeline.reduce((n: number, p: { api_count: number }) => n + p.api_count, 0)).toBe(100);
  });

  it("filters to one step", async () => {
    recordMetric(PROGRAM, "provider_send", "ses", { ok: 1, ms: 10 });
    recordMetric({ program_id: "seq_1", step_id: "step_b" }, "provider_send", "ses", { ok: 1, ms: 10 });
    await flushMetrics();
    const res = await api().get(`${BASE}/seq_1/metrics?range=1h&step_id=step_b`).set(auth);
    expect(res.body.metrics.totals.provider_send.count).toBe(1);
  });

  it("empty is has_data=false, not an error", async () => {
    const res = await api().get(`${BASE}/nothing/metrics`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.metrics).toMatchObject({ has_data: false, window: { range: "24h", resolution_minutes: 15 } });
  });

  it("refuses unknown ranges and unauthenticated calls", async () => {
    expect((await api().get(`${BASE}/seq_1/metrics?range=30d`).set(auth)).status).toBe(400);
    expect((await api().get(`${BASE}/seq_1/metrics`)).status).toBe(401);
  });
});

describe("GET /metrics (every campaign)", () => {
  it("sums across programs and lists each one, busiest first", async () => {
    recordMetric(PROGRAM, "message_resolve", "", { ok: 1, ms: 400 });
    recordMetric(PROGRAM, "provider_send", "ses", { ok: 1, ms: 100 });
    for (let i = 0; i < 3; i++) {
      recordMetric({ program_id: "cmp_2" }, "message_resolve", "", { ok: 1, ms: 300 });
      recordMetric({ program_id: "cmp_2" }, "api_call", "tier", { failed: 1, ms: 50 });
    }
    await flushMetrics();

    const res = await api().get("/api/v1/data-plane/metrics?range=6h").set(auth);
    expect(res.status).toBe(200);
    const m = res.body.metrics;
    expect(m.program_id).toBeNull();
    expect(m.window.resolution_minutes).toBe(5);
    expect(m.totals.message_resolve.count).toBe(4);
    expect(m.steps).toEqual([]);
    expect(m.campaigns.map((c: { program_id: string }) => c.program_id)).toEqual(["cmp_2", "seq_1"]);
    expect(m.campaigns[0]).toMatchObject({ messages: 3, api_calls: 3, api_error_rate: 1 });
  });

  it("validates the range and needs the key", async () => {
    expect((await api().get("/api/v1/data-plane/metrics?range=1y").set(auth)).status).toBe(400);
    expect((await api().get("/api/v1/data-plane/metrics")).status).toBe(401);
  });
});

describe("recording from the resolver", () => {
  beforeEach(() => resetPlaceholdersForTests());

  it("times each api request once and counts recipients served", async () => {
    setDispatchConfigForTests({
      user_lookup: { backend: "mock", fields: {} },
      placeholders: {
        tier: { source: "api", api: { method: "GET", url: "https://crm.example/tier", json_path: "t" }, fallback: "std" },
      },
    } as never);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response('{"t":"gold"}', { status: 200 }));
    const users = ["u1", "u2", "u3"].map((id) => ({ user_id: id, email: "", fields: {} }));
    await resolveDynamicValues(users, { campaign_id: "c", organization_id: "o", metrics: PROGRAM });
    await flushMetrics();

    const res = await api().get(`${BASE}/seq_1/metrics?range=1h`).set(auth);
    // One request (the URL does not vary by user) served three recipients.
    expect(res.body.metrics.variables[0]).toMatchObject({ name: "tier", count: 1, ok: 1, items: 3, fallback: 0 });
  });
});

describe("retention", () => {
  it("prunes rows older than metrics_days (default 7)", async () => {
    recordMetric(PROGRAM, "provider_send", "ses", { ok: 1 }, Date.now() - 8 * 24 * 60 * 60_000);
    recordMetric(PROGRAM, "provider_send", "ses", { ok: 1 });
    await flushMetrics();
    await runRetentionSweep();
    const t = tableFor(dbx, "dispatchMetrics");
    const rows = await queryDb(dbx).select({ minute: t.minute }).from(t);
    expect(rows).toHaveLength(1);
  });
});
