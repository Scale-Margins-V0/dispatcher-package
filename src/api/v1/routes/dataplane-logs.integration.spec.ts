/**
 * Contract tests for the data-plane log surface.
 *
 * Logs are the least structured thing this API returns — `message`, `stack` and
 * `context` are free-form text written by code that was not thinking about a
 * trust boundary. The scrubbing block at the bottom is the point of this file.
 */

import express, { type Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { DispatcherDb } from "../../../db/client.js";
import { insertLogs } from "../../../db/repos/logs.js";
import { createTestDb, destroyTestDb } from "../../../db/test-utils.js";
import type { AppLogRow } from "../../../db/schema/index.js";
import { ATLAS_KEY_ENV } from "../atlas-key.js";
import { registerApiV1Routes, resetApiRateLimitForTests } from "../router.js";

const KEY = "test-atlas-key-0123456789abcdefghijklmnop";
const BASE = "/api/v1/data-plane/logs";

let app: Express;
let dbx: DispatcherDb;
let savedKey: string | undefined;

const auth = { Authorization: `Bearer ${KEY}` };
const api = () => request(app);
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

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
  resetApiRateLimitForTests();
});

function log(overrides: Partial<AppLogRow> = {}): AppLogRow {
  return {
    id: crypto.randomUUID(),
    ts: minutesAgo(5),
    level: "info",
    request_id: "req-1",
    campaign_id: "kyc-q3",
    component: "dispatch",
    message: "Campaign kyc-q3 completed",
    stack: null,
    context: null,
    ...overrides,
  };
}

async function seed(): Promise<void> {
  await insertLogs([
    log({ level: "info", component: "dispatch", message: "Campaign kyc-q3 completed", ts: minutesAgo(5) }),
    log({ level: "warn", component: "variables.resolver", message: "Dynamic variable resolution failed", ts: minutesAgo(10) }),
    log({ level: "error", component: "providers", message: "SES rejected the message", ts: minutesAgo(15) }),
    log({ level: "debug", component: "db", message: "pool acquired", campaign_id: null, ts: minutesAgo(200) }),
  ]);
}

describe("auth", () => {
  it("refuses an unauthenticated read", async () => {
    expect((await api().get(BASE)).status).toBe(401);
  });
});

describe("GET /logs", () => {
  beforeEach(seed);

  it("returns the newest lines first with page meta", async () => {
    const res = await api().get(BASE).set(auth);

    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 25, total: 4, total_pages: 1 });
    expect(res.body.logs[0]).toMatchObject({
      level: "info",
      component: "dispatch",
      message: "Campaign kyc-q3 completed",
      campaign_id: "kyc-q3",
      request_id: "req-1",
    });
  });

  it("filters by exact level", async () => {
    expect((await api().get(`${BASE}?level=error`).set(auth)).body.meta.total).toBe(1);
  });

  it("min_level includes everything more severe", async () => {
    const res = await api().get(`${BASE}?min_level=warn`).set(auth);
    expect(res.body.meta.total).toBe(2);
    expect(res.body.logs.map((l: { level: string }) => l.level).sort()).toEqual(["error", "warn"]);
  });

  it("min_level wins over level when both are sent", async () => {
    const res = await api().get(`${BASE}?level=debug&min_level=warn`).set(auth);
    expect(res.body.meta.total).toBe(2);
  });

  it("filters by component, campaign and message text", async () => {
    expect((await api().get(`${BASE}?component=providers`).set(auth)).body.meta.total).toBe(1);
    expect((await api().get(`${BASE}?campaign_id=kyc-q3`).set(auth)).body.meta.total).toBe(3);
    expect((await api().get(`${BASE}?q=rejected`).set(auth)).body.meta.total).toBe(1);
  });

  it("supports a relative window", async () => {
    // The 200-minute-old debug line falls outside a 1h window.
    expect((await api().get(`${BASE}?since=1h`).set(auth)).body.meta.total).toBe(3);
    expect((await api().get(`${BASE}?since=7d`).set(auth)).body.meta.total).toBe(4);
  });

  it("lets an absolute from override since", async () => {
    const from = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    expect((await api().get(`${BASE}?since=1h&from=${from}`).set(auth)).body.meta.total).toBe(4);
  });

  it("orders ascending on request", async () => {
    const res = await api().get(`${BASE}?order=asc`).set(auth);
    expect(res.body.logs[0].message).toBe("pool acquired");
  });

  it("paginates", async () => {
    const res = await api().get(`${BASE}?page=2&limit=2`).set(auth);
    expect(res.body.logs).toHaveLength(2);
    expect(res.body.meta).toMatchObject({ page: 2, total: 4, total_pages: 2, has_next_page: false });
  });

  const bad: Array<[string, string, string]> = [
    ["an unknown level", "level=verbose", "level"],
    ["a malformed window", "since=soon", "since"],
    ["a non-ISO from", "from=yesterday", "from"],
    ["an inverted range", "from=2026-08-18T00:00:00Z&to=2026-08-17T00:00:00Z", "from"],
    ["limit above the cap", "limit=500", "limit"],
  ];

  it.each(bad)("rejects %s", async (_label, query, path) => {
    const res = await api().get(`${BASE}?${query}`).set(auth);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.details.some((d: { path: string }) => d.path === path)).toBe(true);
  });
});

describe("GET /logs/:id", () => {
  it("returns one line with its stack and context", async () => {
    const row = log({
      level: "error",
      message: "SES rejected the message",
      stack: "Error: rejected\n    at send (/app/src/providers/ses.ts:75:11)",
      context: { provider: "ses", status_code: 554 },
    });
    await insertLogs([row]);

    const res = await api().get(`${BASE}/${row.id}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.log).toMatchObject({
      id: row.id,
      level: "error",
      context: { provider: "ses", status_code: 554 },
    });
    expect(res.body.log.stack).toContain("providers/ses.ts");
  });

  it("404s on an unknown id", async () => {
    expect((await api().get(`${BASE}/nope`).set(auth)).status).toBe(404);
  });
});

describe("no PII escapes in a log line", () => {
  beforeEach(async () => {
    await insertLogs([
      log({
        level: "warn",
        component: "user-lookup.sql",
        message: "No row for ada.lovelace@acme-corp.com (phone +14155550142)",
        stack: "Error: lookup failed for ada.lovelace@acme-corp.com\n    at lookupUsers (/app/src/user-lookup.ts:9:3)",
        context: { email: "ada.lovelace@acme-corp.com", client_ip: "203.0.113.7" },
      }),
    ]);
  });

  it("scrubs the message, the stack and every context value", async () => {
    const res = await api().get(BASE).set(auth);
    const serialized = JSON.stringify(res.body);

    expect(serialized).not.toContain("ada.lovelace@acme-corp.com");
    expect(serialized).not.toContain("14155550142");
    expect(serialized).not.toContain("203.0.113.7");
    expect(serialized).not.toContain("@");

    // The diagnostic value survives.
    const entry = res.body.logs[0];
    expect(entry.message).toContain("No row for");
    expect(entry.stack).toContain("user-lookup.ts");
    expect(entry.component).toBe("user-lookup.sql");
  });

  it("scrubs the single-line endpoint too", async () => {
    const list = await api().get(BASE).set(auth);
    const id = list.body.logs[0].id;

    const res = await api().get(`${BASE}/${id}`).set(auth);
    expect(JSON.stringify(res.body)).not.toContain("ada.lovelace@acme-corp.com");
  });
});
