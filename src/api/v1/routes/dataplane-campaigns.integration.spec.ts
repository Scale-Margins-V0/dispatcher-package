/**
 * Contract tests for the data-plane campaign surface.
 *
 * The load-bearing one is the last block: a provider's rejection text routinely
 * quotes the address it rejected, and ATLAS_API.md promises no recipient
 * address ever reaches ScaleMargin. That has to fail the build, not a review.
 */

import express, { type Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { DispatcherDb } from "../../../db/client.js";
import { upsertDispatchRun } from "../../../db/repos/activity.js";
import { insertCampaignEvents } from "../../../db/repos/campaign-events.js";
import { rebuildAllCampaignSummaries } from "../../../db/repos/campaign-summary.js";
import { insertSendLogs } from "../../../db/repos/send-logs.js";
import { createTestDb, destroyTestDb } from "../../../db/test-utils.js";
import type { CampaignEventRow, DispatchRunRow, SendLogRow } from "../../../db/schema/index.js";
import { ATLAS_KEY_ENV } from "../atlas-key.js";
import { registerApiV1Routes, resetApiRateLimitForTests } from "../router.js";

const KEY = "test-atlas-key-0123456789abcdefghijklmnop";
const BASE = "/api/v1/data-plane/campaigns";

let app: Express;
let dbx: DispatcherDb;
let savedKey: string | undefined;

const auth = { Authorization: `Bearer ${KEY}` };
const api = () => request(app);
const at = (minutes: number) => new Date(Date.UTC(2026, 7, 17, 9, minutes, 0));

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

function run(overrides: Partial<DispatchRunRow> = {}): Omit<DispatchRunRow, "updated_at"> {
  return {
    id: crypto.randomUUID(),
    campaign_id: "cmp_1",
    program_id: "cmp_1",
    program_kind: "campaign",
    step_id: null,
    organization_id: "org_1",
    channel: "email",
    provider: "ses",
    status: "completed",
    recipient_count: 3,
    sent_count: 2,
    failed_count: 1,
    duration_ms: 900,
    resolution_total: 6,
    resolution_fallbacks: 2,
    error_category: null,
    error_message: null,
    error_stack: null,
    occurred_at: at(1),
    ...overrides,
  };
}

function sendLog(overrides: Partial<SendLogRow> = {}): SendLogRow {
  return {
    id: crypto.randomUUID(),
    dispatch_run_id: "run_1",
    campaign_id: "cmp_1",
    program_id: "cmp_1",
    step_id: null,
    organization_id: "org_1",
    user_id: "usr_1024",
    channel: "email",
    provider: "ses",
    template_ref: "kyc-q3",
    status: "sent",
    provider_message_id: "msg-1",
    latency_ms: 120,
    error_category: null,
    error_message: null,
    fallbacks_used: 1,
    occurred_at: at(2),
    ...overrides,
  };
}

function event(overrides: Partial<CampaignEventRow> = {}): CampaignEventRow {
  const id = crypto.randomUUID();
  return {
    id,
    campaign_id: "cmp_1",
    program_id: "cmp_1",
    program_kind: "campaign",
    step_id: null,
    organization_id: "org_1",
    user_id: "usr_1024",
    channel: "email",
    event: "delivered",
    provider: "ses",
    provider_message_id: null,
    occurred_at: at(3),
    received_at: at(3),
    metadata: null,
    dedupe_key: id,
    ...overrides,
  };
}

async function seedCampaigns(): Promise<void> {
  await upsertDispatchRun(run());
  await upsertDispatchRun(
    run({
      campaign_id: "cmp_wa",
      program_id: "cmp_wa",
      channel: "whatsapp",
      provider: "gupshup",
      organization_id: "org_2",
      occurred_at: at(5),
    })
  );
  await insertCampaignEvents([
    event({ user_id: "usr_1024", event: "delivered" }),
    event({ user_id: "usr_1024", event: "opened" }),
    event({ user_id: "usr_2211", event: "delivered" }),
  ]);
  await rebuildAllCampaignSummaries();
}

describe("auth", () => {
  it("refuses an unauthenticated read", async () => {
    expect((await api().get(BASE)).status).toBe(401);
  });
});

describe("GET /campaigns", () => {
  beforeEach(seedCampaigns);

  it("returns the rollup with totals and engagement", async () => {
    const res = await api().get(BASE).set(auth);

    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 25, total: 2, total_pages: 1 });

    const campaign = res.body.campaigns.find(
      (c: { program_id: string }) => c.program_id === "cmp_1"
    );
    expect(campaign).toMatchObject({
      program_kind: "campaign",
      channel: "email",
      provider: "ses",
      totals: { recipients: 3, unique_recipients: 2, sent: 2, failed: 1, fallbacks_used: 2 },
      engagement: { delivered: 2, opened: 1 },
    });
  });

  it("filters by channel, organization, kind and name", async () => {
    expect((await api().get(`${BASE}?channel=whatsapp`).set(auth)).body.meta.total).toBe(1);
    expect((await api().get(`${BASE}?organization_id=org_2`).set(auth)).body.meta.total).toBe(1);
    expect((await api().get(`${BASE}?program_kind=campaign`).set(auth)).body.meta.total).toBe(2);
    expect((await api().get(`${BASE}?q=wa`).set(auth)).body.meta.total).toBe(1);
  });

  it("paginates", async () => {
    const res = await api().get(`${BASE}?page=2&limit=1`).set(auth);
    expect(res.body.campaigns).toHaveLength(1);
    expect(res.body.meta).toMatchObject({
      page: 2,
      total: 2,
      total_pages: 2,
      has_previous_page: true,
      has_next_page: false,
    });
  });

  it("rejects a malformed date range", async () => {
    const bad = await api().get(`${BASE}?from=yesterday`).set(auth);
    expect(bad.status).toBe(400);
    expect(bad.body.details.some((d: { path: string }) => d.path === "from")).toBe(true);

    const inverted = await api()
      .get(`${BASE}?from=2026-08-18T00:00:00Z&to=2026-08-17T00:00:00Z`)
      .set(auth);
    expect(inverted.status).toBe(400);
  });
});

describe("GET /campaigns/:programId", () => {
  beforeEach(seedCampaigns);

  it("returns one campaign with its channel set", async () => {
    const res = await api().get(`${BASE}/cmp_1`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.campaign.program_id).toBe("cmp_1");
    expect(res.body.campaign.channels).toEqual([{ channel: "email", provider: "ses" }]);
    expect(res.body.campaign.steps).toEqual([]);
  });

  it("404s on an unknown campaign", async () => {
    const res = await api().get(`${BASE}/nope`).set(auth);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });
});

describe("GET /campaigns/:programId/sends", () => {
  beforeEach(async () => {
    await seedCampaigns();
    await insertSendLogs([
      sendLog({ user_id: "usr_1024", status: "sent", occurred_at: at(2) }),
      sendLog({ user_id: "usr_2211", status: "sent", occurred_at: at(3) }),
      sendLog({
        user_id: "usr_3300",
        status: "failed",
        provider_message_id: null,
        error_category: "delivery_failure",
        error_message: "550 5.1.1 recipient rejected",
        occurred_at: at(4),
      }),
      // A different campaign, to prove the route is scoped.
      sendLog({ program_id: "cmp_wa", campaign_id: "cmp_wa", user_id: "usr_9999" }),
    ]);
  });

  it("returns only this campaign's sends, newest first", async () => {
    const res = await api().get(`${BASE}/cmp_1/sends`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(3);
    expect(res.body.sends[0]).toMatchObject({
      user_id: "usr_3300",
      status: "failed",
      latency_ms: 120,
      template_ref: "kyc-q3",
    });
  });

  it("filters by status and recipient", async () => {
    expect((await api().get(`${BASE}/cmp_1/sends?status=failed`).set(auth)).body.meta.total).toBe(1);
    expect((await api().get(`${BASE}/cmp_1/sends?status=sent`).set(auth)).body.meta.total).toBe(2);
    expect(
      (await api().get(`${BASE}/cmp_1/sends?user_id=usr_2211`).set(auth)).body.meta.total
    ).toBe(1);
  });

  it("rejects an unknown status", async () => {
    const res = await api().get(`${BASE}/cmp_1/sends?status=maybe`).set(auth);
    expect(res.status).toBe(400);
  });

  it("returns an empty page past the end rather than a 404", async () => {
    const res = await api().get(`${BASE}/cmp_1/sends?page=9`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.sends).toEqual([]);
  });
});

describe("no recipient address ever leaves the dispatcher", () => {
  beforeEach(async () => {
    await seedCampaigns();
    await insertSendLogs([
      sendLog({
        user_id: "usr_3300",
        status: "failed",
        error_category: "delivery_failure",
        // Exactly the shape SES and SendGrid return on a hard bounce.
        error_message: "550 5.1.1 <ada.lovelace@acme-corp.com> user unknown (from 203.0.113.7)",
        occurred_at: at(4),
      }),
    ]);
  });

  it("scrubs the address and the IP out of a provider error", async () => {
    const res = await api().get(`${BASE}/cmp_1/sends?status=failed`).set(auth);
    const serialized = JSON.stringify(res.body);

    expect(serialized).not.toContain("ada.lovelace@acme-corp.com");
    expect(serialized).not.toContain("203.0.113.7");
    expect(serialized).not.toContain("@");
    // The useful part of the diagnosis survives.
    expect(res.body.sends[0].error_message).toContain("550 5.1.1");
    expect(res.body.sends[0].error_category).toBe("delivery_failure");
  });

  it("still exposes the opaque user id, which the platform already holds", async () => {
    const res = await api().get(`${BASE}/cmp_1/sends?status=failed`).set(auth);
    expect(res.body.sends[0].user_id).toBe("usr_3300");
  });
});
