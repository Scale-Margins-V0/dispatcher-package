import express, { type Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherDb } from "../../db/client.js";
import { insertLogs } from "../../db/repos/logs.js";
import { createTestDb, destroyTestDb } from "../../db/test-utils.js";
import {
  SIGN_IN_PATH,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  seedTestAdmin,
  setupAuthForTest,
  teardownAuthForTest,
} from "../../auth/test-utils.js";
import { registerAdminRoutes } from "../routes.js";

let dbx: DispatcherDb;
let app: Express;

const loginAgent = async () => {
  const agent = request.agent(app);
  await agent
    .post(SIGN_IN_PATH)
    .send({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD })
    .expect(200);
  return agent;
};

const row = (i: number, overrides: Partial<Parameters<typeof insertLogs>[0][number]> = {}) => ({
  id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
  ts: new Date(Date.UTC(2026, 6, 14, 10, 0, i)),
  level: "info" as const,
  request_id: null,
  campaign_id: null,
  component: "dispatch",
  message: `message ${i}`,
  stack: null,
  context: null,
  ...overrides,
});

beforeEach(async () => {
  dbx = await createTestDb();
  setupAuthForTest();
  await seedTestAdmin();
  app = express();
  registerAdminRoutes(app);
});

afterEach(() => {
  teardownAuthForTest();
  destroyTestDb(dbx);
});

describe("/admin/api/logs", () => {
  it("requires authentication", async () => {
    await request(app).get("/admin/api/logs").expect(401);
  });

  it("filters by level/campaign and searches message text", async () => {
    await insertLogs([
      row(1),
      row(2, { level: "error", campaign_id: "cmp_9", message: "Campaign cmp_9 failed: boom" }),
      row(3, { message: "unrelated" }),
    ]);
    const agent = await loginAgent();

    const errors = await agent.get("/admin/api/logs").query({ level: "error" }).expect(200);
    expect(errors.body.logs).toHaveLength(1);
    expect(errors.body.logs[0]).toMatchObject({ campaign_id: "cmp_9", level: "error" });

    const search = await agent.get("/admin/api/logs").query({ q: "boom" }).expect(200);
    expect(search.body.logs).toHaveLength(1);

    const byCampaign = await agent
      .get("/admin/api/logs")
      .query({ campaign_id: "cmp_9" })
      .expect(200);
    expect(byCampaign.body.logs).toHaveLength(1);
  });

  it("paginates with a keyset cursor, newest first", async () => {
    await insertLogs(Array.from({ length: 5 }, (_, i) => row(i)));
    const agent = await loginAgent();

    const first = await agent.get("/admin/api/logs").query({ limit: 2 }).expect(200);
    expect(first.body.logs.map((l: { message: string }) => l.message)).toEqual([
      "message 4",
      "message 3",
    ]);
    expect(first.body.next_cursor).toBeTruthy();

    const second = await agent
      .get("/admin/api/logs")
      .query({ limit: 2, cursor: first.body.next_cursor })
      .expect(200);
    expect(second.body.logs.map((l: { message: string }) => l.message)).toEqual([
      "message 2",
      "message 1",
    ]);
  });

  it("returns a single row with stack via /logs/:id", async () => {
    await insertLogs([row(7, { level: "error", stack: "Error: kaput\n  at y.ts:2" })]);
    const agent = await loginAgent();
    const res = await agent
      .get("/admin/api/logs/00000000-0000-0000-0000-000000000007")
      .expect(200);
    expect(res.body.log.stack).toContain("kaput");
    await agent.get("/admin/api/logs/00000000-0000-0000-0000-000000000099").expect(404);
  });
});
