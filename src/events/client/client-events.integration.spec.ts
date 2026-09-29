/**
 * POST /api/scalemargin/client-events — the company's own systems reporting
 * events for sent messages. Off without a secret; authenticated like the
 * provider webhooks; a message is found by request_id or by a saved response
 * value; forwarded to ScaleMargin as Freshchat receipts, never twice.
 */
import { createHmac } from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatcherDb } from "../../db/client.js";
import { queryDb, tableFor } from "../../db/dialect-helpers.js";
import { insertApiResponseRefs } from "../../db/repos/api-response-refs.js";
import { insertProviderMessageIds } from "../../db/repos/provider-message-ids.js";
import { createTestDb, destroyTestDb } from "../../db/test-utils.js";
import { registerInboundWebhookRoutes } from "../../routes/inbound-webhooks.js";

const SECRET = "client-events-secret-0123456789";
const ANALYTICS = "https://app.scalemargins.tech/api/webhooks/campaign-analytics";
const URL_PATH = "/api/scalemargin/client-events";

let app: Express;
let dbx: DispatcherDb;
let analyticsStatus = 200;
const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: analyticsStatus }));
const forwarded = () =>
  fetchMock.mock.calls
    .filter((c) => String(c[0]) === ANALYTICS)
    .flatMap((c) => (JSON.parse(String((c[1] as RequestInit).body)) as { receipts: Array<{ external_id: string; event: string }> }).receipts)
    .map((r) => `${r.external_id}:${r.event}`);

const sentAt = new Date();
const ref = (id: string, request_id: string, user_id: string, value: string) => ({
  id,
  provider: "freshchat",
  provider_message_id: request_id,
  channel: "whatsapp",
  user_id,
  organization_id: "org_1",
  campaign_id: "drip_seq_step",
  dispatch_id: `disp-${user_id}`,
  template_name: "welcome_v1",
  sender_id: "fc_main",
  variable_name: "offer",
  path: "offer.id",
  value,
  sent_at: sentAt,
});

beforeAll(() => {
  app = express();
  registerInboundWebhookRoutes(app);
});
beforeEach(async () => {
  dbx = await createTestDb();
  analyticsStatus = 200;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  process.env.CLIENT_EVENTS_WEBHOOK_SECRET = SECRET;
  process.env.SCALEMARGIN_ANALYTICS_CALLBACK_URL = ANALYTICS;
  process.env.SCALEMARGIN_ANALYTICS_SECRET = "analytics-secret";
  await insertProviderMessageIds([
    { id: "m1", provider: "freshchat", provider_message_id: "req-1", user_id: "u1", sent_at: sentAt },
    { id: "m2", provider: "freshchat", provider_message_id: "req-2", user_id: "u2", sent_at: sentAt },
  ]);
  // OF-1 went only to u1; the shared code GOLD went to both.
  await insertApiResponseRefs([ref("a", "req-1", "u1", "OF-1"), ref("b", "req-1", "u1", "GOLD"), ref("c", "req-2", "u2", "GOLD")]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  destroyTestDb(dbx);
  delete process.env.CLIENT_EVENTS_WEBHOOK_SECRET;
  delete process.env.SCALEMARGIN_ANALYTICS_CALLBACK_URL;
  delete process.env.SCALEMARGIN_ANALYTICS_SECRET;
});
afterAll(() => vi.restoreAllMocks());

const post = (body: unknown, auth: "bearer" | "hmac" | "none" = "bearer") => {
  const raw = JSON.stringify(body);
  const r = request(app).post(URL_PATH).set("Content-Type", "application/json");
  if (auth === "bearer") r.set("Authorization", `Bearer ${SECRET}`);
  if (auth === "hmac") r.set("X-ScaleMargin-Signature", `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`);
  return r.send(raw);
};

describe("access", () => {
  it("is off (404) until events.client_webhook_secret is set", async () => {
    delete process.env.CLIENT_EVENTS_WEBHOOK_SECRET;
    expect((await post({ event: "clicked", request_id: "req-1" })).status).toBe(404);
  });
  it("refuses a missing or wrong secret, accepts Bearer or an HMAC signature", async () => {
    expect((await post({ event: "clicked", request_id: "req-1" }, "none")).status).toBe(401);
    expect((await post({ event: "delivered", request_id: "req-1" }, "hmac")).status).toBe(200);
    expect((await post({ event: "read", request_id: "req-1" }, "bearer")).status).toBe(200);
  });
});

describe("finding the message and forwarding", () => {
  it("by request_id: a click also reports the skipped delivered and read", async () => {
    const res = await post({ event: "clicked", request_id: "req-1", occurred_at: "2026-09-29T10:00:00Z" });
    expect(res.body.results).toEqual([{ index: 0, status: "forwarded", request_id: "req-1" }]);
    expect(forwarded()).toEqual(["req-1:delivered", "req-1:read", "req-1:clicked"]);
  });

  it("by a unique saved value — or a shared one narrowed by user_id", async () => {
    const res = await post({
      events: [
        { event: "clicked", variable_name: "offer", path: "offer.id", value: "OF-1" },
        { event: "clicked", variable_name: "offer", path: "offer.id", value: "GOLD", user_id: "u2" },
      ],
    });
    expect(res.body.results.map((r: { status: string; request_id?: string }) => [r.status, r.request_id])).toEqual([
      ["forwarded", "req-1"],
      ["forwarded", "req-2"],
    ]);
  });

  it("says ambiguous, not_found or invalid instead of guessing — per event", async () => {
    const res = await post([
      { event: "clicked", variable_name: "offer", path: "offer.id", value: "GOLD" },
      { event: "clicked", request_id: "req-nope" },
      { event: "clicked", request_id: "req-1", user_id: "someone-else" },
      { event: "dispatched", request_id: "req-1" },
      { event: "clicked" },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(["ambiguous", "not_found", "not_found", "invalid", "invalid"]);
    expect(forwarded()).toEqual([]);
  });

  it("never reports the same step twice", async () => {
    await post({ event: "read", request_id: "req-1" });
    fetchMock.mockClear();
    const res = await post({ event: "delivered", request_id: "req-1" });
    expect(res.body.results[0].status).toBe("already_reported");
    expect(forwarded()).toEqual([]);
  });

  it("accepts Freshchat-style statuses; failed carries its reason", async () => {
    const res = await post({ event: "FAILED", request_id: "req-2", cause: "blocked", error_code: "131026" });
    expect(res.body.results[0].status).toBe("forwarded");
    const body = JSON.parse(String((fetchMock.mock.calls.find((c) => String(c[0]) === ANALYTICS)![1] as RequestInit).body));
    expect(body.receipts[0]).toMatchObject({ external_id: "req-2", event: "bounced", cause: "blocked", error_code: "131026", provider: "freshchat" });
  });

  it("if ScaleMargin refuses, answers 502 retryable and records nothing as reported", async () => {
    analyticsStatus = 400;
    const res = await post({ event: "read", request_id: "req-1" });
    expect(res.status).toBe(502);
    expect(res.body.retryable).toBe(true);
    const t = tableFor(dbx, "providerMessageIds");
    const rows = (await queryDb(dbx).select().from(t)) as Array<{ provider_message_id: string; status_event: string | null }>;
    expect(rows.find((r) => r.provider_message_id === "req-1")?.status_event ?? null).toBeNull();
  });

  it("rejects bad JSON and oversized batches", async () => {
    const bad = await request(app).post(URL_PATH).set("Authorization", `Bearer ${SECRET}`).send("{nope");
    expect(bad.status).toBe(400);
    const big = await post(Array.from({ length: 501 }, () => ({ event: "read", request_id: "req-1" })));
    expect(big.status).toBe(413);
  });
});
