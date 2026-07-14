import express, { type Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherDb } from "../../db/client.js";
import { createTestDb, destroyTestDb } from "../../db/test-utils.js";
import { personalize } from "../../personalize.js";
import { resetDispatchConfigForTests } from "../../user-lookup/config.js";
import { resetPlaceholdersForTests } from "../../variables/service.js";
import { registerAdminRoutes } from "../routes.js";

const ADMIN_USER = "ops-admin";
const ADMIN_PASSWORD = "correct-horse-battery-staple";

let dbx: DispatcherDb;
let app: Express;

const loginAgent = async () => {
  const agent = request.agent(app);
  const res = await agent
    .post("/admin/api/login")
    .send({ username: ADMIN_USER, password: ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
};

beforeEach(async () => {
  process.env.DISPATCHER_ADMIN_USER = ADMIN_USER;
  process.env.DISPATCHER_ADMIN_PASSWORD = ADMIN_PASSWORD;
  dbx = await createTestDb();
  resetPlaceholdersForTests();
  resetDispatchConfigForTests();
  app = express();
  registerAdminRoutes(app);
});

afterEach(() => {
  destroyTestDb(dbx);
  resetPlaceholdersForTests();
  resetDispatchConfigForTests();
  delete process.env.DISPATCHER_ADMIN_USER;
  delete process.env.DISPATCHER_ADMIN_PASSWORD;
});

describe("/admin/api/variables", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/admin/api/variables");
    expect(res.status).toBe(401);
  });

  it("creates, lists, updates, and deletes a variable", async () => {
    const agent = await loginAgent();

    const created = await agent.post("/admin/api/variables").send({
      name: "nickname",
      source: "field",
      field: "nickname",
      fallback: "friend",
    });
    expect(created.status).toBe(201);
    expect(created.body.variable).toMatchObject({
      name: "nickname",
      source: "field",
      enabled: true,
    });

    const listed = await agent.get("/admin/api/variables");
    expect(listed.status).toBe(200);
    expect(listed.body.variables.map((v: { name: string }) => v.name)).toEqual([
      "nickname",
    ]);

    const updated = await agent.put("/admin/api/variables/nickname").send({
      name: "nickname",
      source: "field",
      field: "alias",
      fallback: "pal",
    });
    expect(updated.status).toBe(200);
    expect(updated.body.variable).toMatchObject({ field: "alias", fallback: "pal" });

    const deleted = await agent.delete("/admin/api/variables/nickname");
    expect(deleted.status).toBe(200);
    const afterDelete = await agent.delete("/admin/api/variables/nickname");
    expect(afterDelete.status).toBe(404);
  });

  it("rejects duplicates with 409 and bad payloads with 400", async () => {
    const agent = await loginAgent();
    await agent
      .post("/admin/api/variables")
      .send({ name: "greeting", source: "computed", expr: "'Hi ' + first_name" });

    const dup = await agent
      .post("/admin/api/variables")
      .send({ name: "greeting", source: "computed", expr: "'Yo'" });
    expect(dup.status).toBe(409);

    const badName = await agent
      .post("/admin/api/variables")
      .send({ name: "1bad name", source: "field", field: "x" });
    expect(badName.status).toBe(400);

    const badExpr = await agent
      .post("/admin/api/variables")
      .send({ name: "broken", source: "computed", expr: "first_name * 2" });
    expect(badExpr.status).toBe(400);
    expect(JSON.stringify(badExpr.body.details)).toMatch(/invalid expression/);
  });

  it("validate endpoint returns previews without persisting", async () => {
    const agent = await loginAgent();
    const res = await agent.post("/admin/api/variables/validate").send({
      name: "full_name",
      source: "computed",
      expr: "first_name + ' ' + last_name",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, preview: "Ada Lovelace" });

    const listed = await agent.get("/admin/api/variables");
    expect(listed.body.variables).toEqual([]);
  });

  it("edits apply to personalize() immediately — no restart", async () => {
    const agent = await loginAgent();
    await agent.post("/admin/api/variables").send({
      name: "signoff",
      source: "computed",
      expr: "'Cheers, ' + first_name",
    });

    const user = {
      user_id: "u1",
      email: "u1@example.com",
      fields: { first_name: "Priya" },
    };
    expect(personalize("{{signoff}}", user)).toBe("Cheers, Priya");

    await agent.put("/admin/api/variables/signoff").send({
      name: "signoff",
      source: "computed",
      expr: "'Regards, ' + first_name",
    });
    expect(personalize("{{signoff}}", user)).toBe("Regards, Priya");
  });
});
