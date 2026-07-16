import express, { type Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherDb } from "../../db/client.js";
import { insertRecipientFailure, upsertDispatchRun } from "../../db/repos/activity.js";
import { upsertCampaignCallback } from "../../db/repos/campaign-callbacks.js";
import { insertCampaignEvents } from "../../db/repos/campaign-events.js";
import { enqueueOutbox } from "../../db/repos/outbox.js";
import type { CampaignEventRow } from "../../db/schema/index.js";
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

const T0 = new Date("2026-07-10T10:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

let seq = 0;
const ev = (partial: Partial<CampaignEventRow>): CampaignEventRow => {
  seq += 1;
  return {
    id: `evt-${String(seq).padStart(4, "0")}`,
    campaign_id: "cmp_1",
    organization_id: "org_1",
    user_id: `user-${seq}`,
    channel: "email",
    event: "dispatched",
    provider: "ses",
    provider_message_id: `msg-${seq}`,
    occurred_at: at(seq),
    received_at: at(seq),
    metadata: null,
    dedupe_key: `dk-${seq}`,
    ...partial,
  };
};

async function seedRun(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = crypto.randomUUID();
  await upsertDispatchRun({
    id,
    campaign_id: "cmp_1",
    organization_id: "org_1",
    channel: "email",
    provider: "ses",
    status: "completed",
    recipient_count: 3,
    sent_count: 2,
    failed_count: 1,
    duration_ms: 120,
    error_category: null,
    error_message: null,
    error_stack: null,
    occurred_at: T0,
    ...overrides,
  } as never);
  return id;
}

beforeEach(async () => {
  seq = 0;
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

describe("/admin/api/campaigns", () => {
  it("requires authentication on every route", async () => {
    for (const path of [
      "/admin/api/campaigns",
      "/admin/api/campaigns/cmp_1",
      "/admin/api/campaigns/cmp_1/recipients",
      "/admin/api/campaigns/cmp_1/recipients/u1",
      "/admin/api/campaigns/cmp_1/events",
      "/admin/api/campaigns/cmp_1/runs",
      "/admin/api/campaigns/cmp_1/outbox",
    ]) {
      await request(app).get(path).expect(401);
    }
  });

  it("lists campaigns with aggregates, channels, funnel and callback flag", async () => {
    await seedRun({});
    await seedRun({ campaign_id: "cmp_2", channel: "whatsapp", provider: "gupshup", occurred_at: at(5) });
    await insertCampaignEvents([
      ev({ user_id: "u1", event: "dispatched" }),
      ev({ user_id: "u1", event: "delivered" }),
    ]);
    await upsertCampaignCallback("cmp_1", "org_1", "https://client.example/analytics?secret=x");

    const agent = await loginAgent();
    const res = await agent.get("/admin/api/campaigns").expect(200);
    expect(res.body.campaigns).toHaveLength(2);
    const [newest, older] = res.body.campaigns;
    expect(newest.campaign_id).toBe("cmp_2");
    expect(newest.channels).toEqual(["whatsapp"]);
    expect(newest.has_callback).toBe(false);
    expect(newest.events).toBeNull();
    expect(older.campaign_id).toBe("cmp_1");
    expect(older.sent).toBe(2);
    expect(older.has_callback).toBe(true);
    expect(older.events.delivered).toBe(1);
  });

  it("rejects a malformed cursor", async () => {
    const agent = await loginAgent();
    await agent.get("/admin/api/campaigns").query({ cursor: "nope" }).expect(400);
  });

  it("serves the campaign detail header and 404s for unknown ids", async () => {
    await seedRun({ status: "accepted", occurred_at: new Date() });
    await insertCampaignEvents([ev({ user_id: "u1", event: "dispatched" })]);
    await upsertCampaignCallback("cmp_1", "org_1", "https://client.example/hooks/analytics");
    await enqueueOutbox([
      {
        callback_url: "https://client.example/hooks/analytics",
        campaign_id: "cmp_1",
        organization_id: "org_1",
        event: { event: "dispatched" },
        idempotency_key: "ik-1",
      },
    ]);

    const agent = await loginAgent();
    const res = await agent.get("/admin/api/campaigns/cmp_1").expect(200);
    expect(res.body.campaign).toMatchObject({
      campaign_id: "cmp_1",
      organization_id: "org_1",
      active: true,
      callback: {
        registered: true,
        destination: "https://client.example/hooks/analytics",
      },
      outbox: { pending: 1 },
    });
    expect(res.body.campaign.funnel.dispatched).toBe(1);

    await agent.get("/admin/api/campaigns/never_seen").expect(404);
  });

  it("rolls up recipients with stages, chips and status filter", async () => {
    await insertCampaignEvents([
      ev({ user_id: "clicker", event: "dispatched", occurred_at: at(1) }),
      ev({ user_id: "clicker", event: "delivered", occurred_at: at(2) }),
      ev({ user_id: "clicker", event: "clicked", occurred_at: at(3) }),
      ev({ user_id: "bouncer", event: "dispatched", occurred_at: at(1) }),
      ev({ user_id: "bouncer", event: "bounced", occurred_at: at(4) }),
    ]);
    const agent = await loginAgent();

    const res = await agent.get("/admin/api/campaigns/cmp_1/recipients").expect(200);
    expect(res.body.status_counts.clicked).toBe(1);
    expect(res.body.status_counts.bounced).toBe(1);
    const bouncer = res.body.recipients.find(
      (r: { user_id: string }) => r.user_id === "bouncer"
    );
    expect(bouncer.status).toBe("bounced");
    expect(bouncer.stages.dispatched).toBe(true);
    expect(bouncer.flags.bounced).toBe(true);

    const filtered = await agent
      .get("/admin/api/campaigns/cmp_1/recipients")
      .query({ status: "clicked" })
      .expect(200);
    expect(filtered.body.recipients.map((r: { user_id: string }) => r.user_id)).toEqual([
      "clicker",
    ]);
  });

  it("returns a recipient timeline merged with send-time failures", async () => {
    const runId = await seedRun({});
    await insertCampaignEvents([
      ev({ user_id: "u-fail", event: "failed", occurred_at: at(2) }),
    ]);
    await insertRecipientFailure({
      id: crypto.randomUUID(),
      dispatch_run_id: runId,
      campaign_id: "cmp_1",
      user_id: "u-fail",
      provider: "ses",
      error_category: "provider_rejected",
      error_message: "Address suppressed",
      error_stack: null,
      context: { code: 554 },
      occurred_at: at(2),
    });

    const agent = await loginAgent();
    const res = await agent.get("/admin/api/campaigns/cmp_1/recipients/u-fail").expect(200);
    expect(res.body.status).toBe("failed");
    expect(res.body.events).toHaveLength(1);
    expect(res.body.recipient_failures[0]).toMatchObject({
      error_category: "provider_rejected",
      context: { code: 554 },
    });

    await agent.get("/admin/api/campaigns/cmp_1/recipients/ghost").expect(404);
  });

  it("feeds events with type filter and pagination", async () => {
    await insertCampaignEvents([
      ev({ user_id: "u1", event: "dispatched", occurred_at: at(1) }),
      ev({ user_id: "u1", event: "delivered", occurred_at: at(2), metadata: { smtp: "250 OK" } }),
      ev({ user_id: "u2", event: "bounced", occurred_at: at(3), metadata: { bounce_type: "hard" } }),
    ]);
    const agent = await loginAgent();

    const bounced = await agent
      .get("/admin/api/campaigns/cmp_1/events")
      .query({ event: "bounced" })
      .expect(200);
    expect(bounced.body.events).toHaveLength(1);
    expect(bounced.body.events[0].metadata).toEqual({ bounce_type: "hard" });

    const page1 = await agent
      .get("/admin/api/campaigns/cmp_1/events")
      .query({ limit: 2 })
      .expect(200);
    expect(page1.body.events).toHaveLength(2);
    const page2 = await agent
      .get("/admin/api/campaigns/cmp_1/events")
      .query({ limit: 2, cursor: page1.body.next_cursor })
      .expect(200);
    expect(page2.body.events).toHaveLength(1);
    expect(page2.body.next_cursor).toBeNull();
  });

  it("wraps dispatch runs per campaign in the shared shape", async () => {
    await seedRun({});
    await seedRun({ campaign_id: "cmp_other" });
    const agent = await loginAgent();
    const res = await agent.get("/admin/api/campaigns/cmp_1/runs").expect(200);
    expect(res.body.dispatches).toHaveLength(1);
    expect(res.body.dispatches[0]).toMatchObject({ campaign_id: "cmp_1", status: "completed" });
  });

  it("exposes forwarding entries with redacted destinations and envelopes", async () => {
    await enqueueOutbox([
      {
        callback_url: "https://client.example/hooks/analytics?token=SECRET",
        campaign_id: "cmp_1",
        organization_id: "org_1",
        event: { event: "delivered", user_id: "u1" },
        idempotency_key: "ik-1",
      },
      {
        callback_url: "https://client.example/hooks/analytics?token=SECRET",
        campaign_id: "cmp_other",
        organization_id: "org_1",
        event: { event: "delivered", user_id: "u2" },
        idempotency_key: "ik-2",
      },
    ]);
    const agent = await loginAgent();
    const res = await agent.get("/admin/api/campaigns/cmp_1/outbox").expect(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].destination).toBe("https://client.example/hooks/analytics");
    expect(res.body.entries[0].destination).not.toContain("SECRET");
    expect(res.body.entries[0].event).toEqual({ event: "delivered", user_id: "u1" });
    expect(res.body.status_counts.pending).toBe(1);

    const filtered = await agent
      .get("/admin/api/campaigns/cmp_1/outbox")
      .query({ status: "delivered" })
      .expect(200);
    expect(filtered.body.entries).toHaveLength(0);
  });
});
