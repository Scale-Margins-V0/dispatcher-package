/**
 * Gupshup inbound webhook — log-only mode (forwarding explicitly disabled).
 *
 * Gupshup forwards by default, so this test opts out with
 * EVENT_PROVIDERS_DISABLED=gupshup. The endpoint then always accepts + logs the
 * payload and returns 200, but forwards nothing to the backend event caller.
 */
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initializeEventPipeline,
  resetEventPipelineForTests,
  setEventsConfigForTests,
  shutdownEventPipeline,
} from "../index.js";
import { loadEventsConfigFromYaml } from "../config.js";

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
      enabled: false
      secret_env: GUPSHUP_WEBHOOK_SECRET
`;

describe("POST /api/scalemargin/gupshup-events (log-only, forwarding disabled)", () => {
  let app: import("express").Express;
  const fetchMock = vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  );

  beforeAll(async () => {
    process.env.VITEST = "true";
    process.env.SCALEMARGIN_DISPATCH_SECRET = "d";
    process.env.SCALEMARGIN_ANALYTICS_SECRET = "analytics-secret";
    process.env.NODE_ENV = "test";
    delete process.env.GUPSHUP_WEBHOOK_SECRET;
    process.env.EVENT_PROVIDERS_DISABLED = "gupshup";

    vi.stubGlobal("fetch", fetchMock);

    resetEventPipelineForTests();
    setEventsConfigForTests(loadEventsConfigFromYaml(yaml));

    const mod = await import("../../index.js");
    app = mod.app;
    initializeEventPipeline();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    delete process.env.EVENT_PROVIDERS_DISABLED;
    shutdownEventPipeline();
    resetEventPipelineForTests();
  });

  beforeEach(() => {
    fetchMock.mockClear();
  });

  it("accepts the payload, returns forwarded:false, and does not forward", async () => {
    const res = await request(app)
      .post("/api/scalemargin/gupshup-events")
      .set("Content-Type", "application/json")
      .send({ type: "message-event", eventType: "read", msgId: "m1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, forwarded: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts unsigned / arbitrary payloads without 401 or 400", async () => {
    const res = await request(app)
      .post("/api/scalemargin/gupshup-events")
      .set("Content-Type", "text/plain")
      .send("not even json");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, forwarded: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
