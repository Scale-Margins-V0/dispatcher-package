import express, { type Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherDb } from "../../db/client.js";
import {
  SIGN_IN_PATH,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  seedTestAdmin,
  setupAuthForTest,
  teardownAuthForTest,
} from "../../auth/test-utils.js";
import { createTestDb, destroyTestDb } from "../../db/test-utils.js";
import { registerAdminRoutes } from "../routes.js";

let dbx: DispatcherDb;
let app: Express;

const ownerAgent = async () => {
  const agent = request.agent(app);
  await agent
    .post(SIGN_IN_PATH)
    .send({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD })
    .expect(200);
  return agent;
};

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

describe("settings/members + invitations", () => {
  it("requires authentication", async () => {
    await request(app).get("/admin/api/settings/members").expect(401);
    await request(app).get("/admin/api/settings/invitations").expect(401);
  });

  it("lists the seeded owner as a member", async () => {
    const agent = await ownerAgent();
    const res = await agent.get("/admin/api/settings/members").expect(200);
    expect(res.body.members).toHaveLength(1);
    expect(res.body.members[0]).toMatchObject({ role: "owner" });
    expect(res.body.members[0].user.email).toBe(TEST_ADMIN_EMAIL);
  });

  it("invites a member and returns a copyable accept link", async () => {
    const agent = await ownerAgent();
    const res = await agent
      .post("/admin/api/settings/invitations")
      .send({ email: "invitee@example.com", role: "member" })
      .expect(201);
    expect(res.body.accept_url).toContain("/admin/#settings/accept?token=");
    expect(res.body.invitation.id).toBeTruthy();

    const list = await agent.get("/admin/api/settings/invitations").expect(200);
    expect(list.body.invitations.map((i: { email: string }) => i.email)).toContain(
      "invitee@example.com"
    );
  });

  it("accepts an invitation: creates the account and joins the org", async () => {
    const agent = await ownerAgent();
    const invite = await agent
      .post("/admin/api/settings/invitations")
      .send({ email: "newbie@example.com", role: "member" })
      .expect(201);
    const token = invite.body.invitation.id as string;

    const accept = await request(app)
      .post("/admin/api/accept-invite")
      .send({ token, name: "New Bie", password: "brand-new-password-123" })
      .expect(200);
    expect(accept.body.accepted).toBe(true);

    // The new account can now sign in.
    await request(app)
      .post(SIGN_IN_PATH)
      .send({ email: "newbie@example.com", password: "brand-new-password-123" })
      .expect(200);

    // And shows up as a member.
    const members = await agent.get("/admin/api/settings/members").expect(200);
    expect(members.body.members.map((m: { user: { email: string } }) => m.user.email)).toContain(
      "newbie@example.com"
    );
  });

  it("rejects accept with an unknown token", async () => {
    await request(app)
      .post("/admin/api/accept-invite")
      .send({ token: "does-not-exist", name: "X", password: "brand-new-password-123" })
      .expect(404);
  });

  it("rejects accept with a short password", async () => {
    const agent = await ownerAgent();
    const invite = await agent
      .post("/admin/api/settings/invitations")
      .send({ email: "shortpw@example.com", role: "member" })
      .expect(201);
    await request(app)
      .post("/admin/api/accept-invite")
      .send({ token: invite.body.invitation.id, name: "Sh", password: "short" })
      .expect(400);
  });
});
