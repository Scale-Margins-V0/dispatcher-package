/**
 * SES SNS -> inbound handler (SNS verify mocked via spy).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { loadEventsConfigFromYaml } from "../config.js";
import {
  initializeEventPipeline,
  resetEventPipelineForTests,
  setEventsConfigForTests,
  shutdownEventPipeline,
} from "../index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
      enabled: true
    gupshup:
      enabled: false
`;

describe("POST /api/scalemargin/ses-notifications (integration)", () => {
  let app: import("express").Express;
  let campaignRegistry: typeof import("../campaign-callback-registry.js");
  const fetchMock = vi.fn(() =>
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
    process.env.EVENT_FORWARD_MODE = "sync";
    process.env.NODE_ENV = "test";

    vi.stubGlobal("fetch", fetchMock);

    resetEventPipelineForTests();
    setEventsConfigForTests(loadEventsConfigFromYaml(yaml));

    vi.resetModules();
    const sns = await import("../sns-verify.js");
    vi.spyOn(sns, "verifySnsMessage").mockResolvedValue(true);

    const mod = await import("../../index.js");
    app = mod.app;

    campaignRegistry = await import("../campaign-callback-registry.js");
    campaignRegistry.resetCampaignCallbackRegistryForTests();
    campaignRegistry.registerCampaignCallback(
      "c_test_1",
      "org_1",
      "http://127.0.0.1:19999/api/webhooks/campaign-analytics/test"
    );

    initializeEventPipeline();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    shutdownEventPipeline();
    resetEventPipelineForTests();
    campaignRegistry?.resetCampaignCallbackRegistryForTests();
    delete process.env.EVENT_FORWARD_MODE;
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    fetchMock.mockClear();
  });

  it("confirms SubscriptionConfirmation without calling inner adapter", async () => {
    const buf = readFileSync(
      join(__dirname, "../__fixtures__/ses", "subscription-confirmation.json"),
      "utf8"
    );
    const res = await request(app)
      .post("/api/scalemargin/ses-notifications")
      .set("Content-Type", "application/json")
      .send(buf);
    expect(res.status).toBe(200);
    expect(res.body.confirmed).toBeTruthy();
  });

  it("processes delivery notification and forwards", async () => {
    const buf = readFileSync(
      join(__dirname, "../__fixtures__/ses", "delivery-notification.json"),
      "utf8"
    );
    const res = await request(app)
      .post("/api/scalemargin/ses-notifications")
      .set("Content-Type", "application/json")
      .send(buf);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("forwards SES delivery when campaign registry is empty but SCALEMARGIN_ANALYTICS_CALLBACK_URL is set", async () => {
    const fallbackUrl =
      "http://127.0.0.1:19999/api/webhooks/campaign-analytics/test";
    const prev = process.env.SCALEMARGIN_ANALYTICS_CALLBACK_URL;
    process.env.SCALEMARGIN_ANALYTICS_CALLBACK_URL = fallbackUrl;
    campaignRegistry.resetCampaignCallbackRegistryForTests();
    fetchMock.mockClear();

    try {
      const buf = readFileSync(
        join(__dirname, "../__fixtures__/ses", "delivery-notification.json"),
        "utf8"
      );
      const res = await request(app)
        .post("/api/scalemargin/ses-notifications")
        .set("Content-Type", "application/json")
        .send(buf);
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalled();
      const firstCall = (fetchMock.mock.calls as unknown[][])[0];
      expect(String(firstCall?.[0])).toBe(fallbackUrl);
    } finally {
      if (prev === undefined) {
        delete process.env.SCALEMARGIN_ANALYTICS_CALLBACK_URL;
      } else {
        process.env.SCALEMARGIN_ANALYTICS_CALLBACK_URL = prev;
      }
      campaignRegistry.resetCampaignCallbackRegistryForTests();
      campaignRegistry.registerCampaignCallback(
        "c_test_1",
        "org_1",
        "http://127.0.0.1:19999/api/webhooks/campaign-analytics/test"
      );
    }
  });

  it("processes Subscription event as unsubscribed analytics", async () => {
    const buf = readFileSync(
      join(
        __dirname,
        "../__fixtures__/ses",
        "subscription-event-notification.json"
      ),
      "utf8"
    );
    const res = await request(app)
      .post("/api/scalemargin/ses-notifications")
      .set("Content-Type", "application/json")
      .send(buf);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
    const call = (fetchMock.mock.calls as unknown[][]).find((c) =>
      String(c[0]).includes("campaign-analytics")
    );
    expect(call).toBeDefined();
    const init = (call as unknown as [string, RequestInit])[1];
    const body = JSON.parse(String(init?.body ?? "")) as {
      events?: {
        event: string;
        metadata?: { unsubscribe_source?: string };
      }[];
    };
    expect(body.events?.[0]?.event).toBe("unsubscribed");
    expect(body.events?.[0]?.metadata?.unsubscribe_source).toBe(
      "ses_subscription"
    );
  });

  it("returns 400 for malformed SNS JSON envelope", async () => {
    const res = await request(app)
      .post("/api/scalemargin/ses-notifications")
      .set("Content-Type", "application/json")
      .send("{");

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: "Invalid JSON" });
  });
});
