import express, { type Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherDb } from "./db/client.js";
import { insertLogs } from "./db/repos/logs.js";
import { createTestDb, destroyTestDb } from "./db/test-utils.js";
import type { AppLogRow, LogLevel } from "./db/schema/index.js";
import { registerLogsApiRoutes } from "./logs-api.js";

let dbx: DispatcherDb;
let app: Express;

const row = (i: number, level: LogLevel, secondsAgo: number, over: Partial<AppLogRow> = {}): AppLogRow => ({
  id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
  ts: new Date(Date.now() - secondsAgo * 1000),
  level,
  request_id: null,
  campaign_id: null,
  component: "test",
  message: `message ${i}`,
  stack: null,
  context: null,
  ...over,
});

beforeEach(async () => {
  dbx = await createTestDb();
  process.env.DISPATCHER_LOGS_API_TOKEN = "test-logs-token";
  app = express();
  registerLogsApiRoutes(app);
  await insertLogs([
    row(1, "info", 10),
    row(2, "warn", 8, { campaign_id: "cmpA" }),
    row(3, "error", 6, { request_id: "req-9" }),
    row(4, "info", 4000), // >1h ago
  ]);
});

afterEach(() => {
  destroyTestDb(dbx);
  delete process.env.DISPATCHER_LOGS_API_TOKEN;
});

const auth = () => request(app).get("/logs").set("Authorization", "Bearer test-logs-token");

describe("GET /logs auth", () => {
  it("401s without a token", async () => {
    await request(app).get("/logs").expect(401);
  });
  it("401s with a wrong token", async () => {
    await request(app).get("/logs").set("Authorization", "Bearer nope").expect(401);
  });
  it("200s with the right token", async () => {
    const res = await auth().expect(200);
    expect(res.body.logs.length).toBe(4);
    expect(res.body.count).toBe(4);
  });
});

describe("GET /logs filters", () => {
  it("min_level returns warn+ only", async () => {
    const res = await auth().query({ min_level: "warn" }).expect(200);
    expect(res.body.logs.map((l: { level: string }) => l.level).sort()).toEqual(["error", "warn"]);
  });
  it("since=1h excludes the old entry", async () => {
    const res = await auth().query({ since: "1h" }).expect(200);
    expect(res.body.logs.length).toBe(3);
  });
  it("filters by campaign_id and request_id", async () => {
    expect((await auth().query({ campaign_id: "cmpA" })).body.logs.length).toBe(1);
    expect((await auth().query({ request_id: "req-9" })).body.logs[0].level).toBe("error");
  });
  it("respects limit and paginates via next_cursor", async () => {
    const first = await auth().query({ limit: 2 }).expect(200);
    expect(first.body.logs.length).toBe(2);
    expect(first.body.next_cursor).toBeTruthy();
    const second = await auth().query({ limit: 2, cursor: first.body.next_cursor }).expect(200);
    expect(second.body.logs.length).toBe(2);
    const ids = new Set([...first.body.logs, ...second.body.logs].map((l: { id: string }) => l.id));
    expect(ids.size).toBe(4);
  });
  it("rejects an invalid query", async () => {
    await auth().query({ min_level: "bogus" }).expect(400);
  });
});
