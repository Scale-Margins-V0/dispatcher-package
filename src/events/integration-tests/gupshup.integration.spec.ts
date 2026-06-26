/**
 * Gupshup inbound webhook (HMAC + fetch mock).
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initializeEventPipeline,
  resetEventPipelineForTests,
  setEventsConfigForTests,
  shutdownEventPipeline,
} from "../index.js";
import { loadEventsConfigFromYaml } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const secret = "gup-int-secret";

const yaml = `
events:
  forward:
    mode: sync
    batch_size: 10
    batch_interval_ms: 1000
  delivery:
    mode: best_effort
    buffer:
      kind: memory
      max_events_memory: 100
  providers:
    sendgrid:
      enabled: false
    ses:
      enabled: false
    gupshup:
      enabled: true
      secret_env: GUPSHUP_WEBHOOK_SECRET
`;

describe("POST /api/scalemargin/gupshup-events (integration)", () => {
  let app: import("express").Express;
  const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ events_processed: 1 }),
    })
  );

  beforeAll(async () => {
    process.env.VITEST = "true";
    process.env.SCALEMARGIN_DISPATCH_SECRET = "d";
    process.env.SCALEMARGIN_ANALYTICS_SECRET = "analytics-secret";
    process.env.GUPSHUP_WEBHOOK_SECRET = secret;
    process.env.EVENT_FORWARD_MODE = "sync";
    process.env.NODE_ENV = "test";

    vi.stubGlobal("fetch", fetchMock);

    resetEventPipelineForTests();
    setEventsConfigForTests(loadEventsConfigFromYaml(yaml));

    const mod = await import("../../index.js");
    app = mod.app;
    initializeEventPipeline();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    shutdownEventPipeline();
    resetEventPipelineForTests();
    delete process.env.GUPSHUP_WEBHOOK_SECRET;
    delete process.env.EVENT_FORWARD_MODE;
    delete process.env.SCALEMARGIN_ANALYTICS_SECRET;
  });

  beforeEach(() => {
    fetchMock.mockClear();
  });

  it("verifies HMAC and forwards read event", async () => {
    const json = readFileSync(join(__dirname, "../__fixtures__/gupshup", "read.json"), "utf-8");
    const sig = createHmac("sha256", secret).update(json, "utf8").digest("hex");
    const res = await request(app)
      .post("/api/scalemargin/gupshup-events")
      .set("Content-Type", "application/json")
      .set("x-gupshup-signature", sig)
      .send(json);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
    const call = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("campaign-analytics")
    );
    expect(call).toBeDefined();
    expect(String(call?.[0])).toContain(
      "http://127.0.0.1:19999/api/webhooks/campaign-analytics/test"
    );
    const init = call?.[1] as RequestInit | undefined;
    const posted = JSON.parse(String(init?.body ?? "")) as {
      campaign_id?: string;
      organization_id?: string;
      events?: Array<{
        user_id: string;
        event: string;
        channel: string;
        metadata?: { provider?: string; provider_message_id?: string };
      }>;
    };
    expect(posted.campaign_id).toBe("c_test_1");
    expect(posted.organization_id).toBe("org_1");
    expect(posted.events?.[0]).toMatchObject({
      user_id: "u_42",
      event: "opened",
      channel: "whatsapp",
      metadata: {
        provider: "gupshup",
        provider_message_id: "gup-msg-1",
      },
    });
  });

  it("returns 400 for malformed JSON payload", async () => {
    const badJson = "{";
    const sig = createHmac("sha256", secret).update(badJson, "utf8").digest("hex");
    const res = await request(app)
      .post("/api/scalemargin/gupshup-events")
      .set("Content-Type", "application/json")
      .set("x-gupshup-signature", sig)
      .send(badJson);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid webhook payload" });
  });

  it("accepts a GatewayAPI receipt carrying our smsign_ extra", async () => {
    const raw = JSON.stringify([
      {
        channel: "WHATSAPP",
        externalId: "ext-signed-1",
        eventType: "READ",
        eventTs: 1782450922000,
        extra: "smsign_88354b906ff911f19f5183d05b01c0e1",
      },
    ]);
    const sig = createHmac("sha256", secret).update(raw, "utf8").digest("hex");
    const res = await request(app)
      .post("/api/scalemargin/gupshup-events")
      .set("Content-Type", "application/json")
      .set("x-gupshup-signature", sig)
      .send(raw);

    expect(res.status).toBe(200);
    expect(res.body.receipts).toBe(1);
  });

  it("rejects a GatewayAPI receipt whose extra is missing or not smsign_", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const raw = JSON.stringify([
        {
          channel: "WHATSAPP",
          externalId: "ext-unsigned-1",
          eventType: "READ",
          eventTs: 1782450922000,
          extra: "88354b90-6ff9-11f1-9f51-83d05b01c0e1",
        },
      ]);
      const sig = createHmac("sha256", secret).update(raw, "utf8").digest("hex");
      const res = await request(app)
        .post("/api/scalemargin/gupshup-events")
        .set("Content-Type", "application/json")
        .set("x-gupshup-signature", sig)
        .send(raw);

      expect(res.status).toBe(200);
      expect(res.body.receipts).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Rejecting receipt externalId=ext-unsigned-1")
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("warns and drops unknown gupshup status", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const raw = JSON.stringify({
        type: "message-event",
        msgId: "gup-unknown-1",
        timestamp: "2021-01-01T12:01:00.000Z",
        eventType: "queued_elsewhere",
        tag: JSON.stringify({
          campaign_id: "c_test_1",
          user_id: "u_42",
          organization_id: "org_1",
          analytics_callback_url:
            "http://127.0.0.1:19999/api/webhooks/campaign-analytics/test",
        }),
      });
      const sig = createHmac("sha256", secret).update(raw, "utf8").digest("hex");
      const res = await request(app)
        .post("/api/scalemargin/gupshup-events")
        .set("Content-Type", "application/json")
        .set("x-gupshup-signature", sig)
        .send(raw);

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "[Events][gupshup] Dropping event — unsupported status mapping: queued_elsewhere"
      );
    } finally {
      warn.mockRestore();
    }
  });
});
