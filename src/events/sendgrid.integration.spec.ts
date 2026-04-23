/**
 * SendGrid inbound webhook → forwarder (fetch mock).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { EventWebhook } from "@sendgrid/eventwebhook";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  initializeEventPipeline,
  resetEventPipelineForTests,
  setEventsConfigForTests,
  shutdownEventPipeline,
} from "./index.js";
import { loadEventsConfigFromYaml } from "./config.js";

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
      enabled: true
      signing_key_env: SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY
    ses:
      enabled: false
    gupshup:
      enabled: false
`;

describe("POST /api/scalemargin/sendgrid-events (integration)", () => {
  let app: import("express").Express;
  let verifySpy: { mockRestore: () => void; mockReturnValueOnce: (v: boolean) => void };
  const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const u = typeof input === "string" ? input : input.toString();
    if (u.includes("campaign-analytics")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ events_processed: 1 }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, text: async () => "" });
  });

  beforeAll(async () => {
    process.env.VITEST = "true";
    process.env.SCALEMARGIN_DISPATCH_SECRET = "d";
    process.env.SCALEMARGIN_ANALYTICS_SECRET = "analytics-secret";
    process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY =
      "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g==";
    process.env.EVENT_FORWARD_MODE = "sync";
    process.env.NODE_ENV = "test";

    vi.stubGlobal("fetch", fetchMock);

    resetEventPipelineForTests();
    setEventsConfigForTests(loadEventsConfigFromYaml(yaml));
    verifySpy = vi.spyOn(EventWebhook.prototype, "verifySignature").mockReturnValue(true) as typeof verifySpy;

    const mod = await import("../index.js");
    app = mod.app;
    initializeEventPipeline();
  });

  afterAll(() => {
    verifySpy.mockRestore();
    vi.unstubAllGlobals();
    shutdownEventPipeline();
    resetEventPipelineForTests();
    delete process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
    delete process.env.EVENT_FORWARD_MODE;
  });

  beforeEach(() => {
    fetchMock.mockClear();
  });

  it("accepts fixture array and POSTs PII-safe payload to analytics URL", async () => {
    const one = JSON.parse(
      readFileSync(join(__dirname, "__fixtures__/sendgrid", "delivered.json"), "utf-8")
    );
    const body = JSON.stringify([one]) + "\r\n";
    const res = await request(app)
      .post("/api/scalemargin/sendgrid-events")
      .set("Content-Type", "application/json")
      .set("X-Twilio-Email-Event-Webhook-Signature", "sig")
      .set("X-Twilio-Email-Event-Webhook-Timestamp", "1234567890")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(fetchMock).toHaveBeenCalled();
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("campaign-analytics"));
    expect(call).toBeDefined();
    const init = call![1] as RequestInit | undefined;
    const bodyStr = String(init?.body ?? "");
    const posted = JSON.parse(bodyStr) as {
      events?: Array<{ user_id: string }>;
    };
    expect(posted.events?.[0]?.user_id).toBe("u_42");
    expect(bodyStr).not.toMatch(/recipient@example/);
  });

  it("returns 401 when signature verify fails", async () => {
    verifySpy.mockReturnValueOnce(false);
    const res = await request(app)
      .post("/api/scalemargin/sendgrid-events")
      .set("Content-Type", "application/json")
      .set("X-Twilio-Email-Event-Webhook-Signature", "bad")
      .set("X-Twilio-Email-Event-Webhook-Timestamp", "1")
      .send("[{}]");
    expect(res.status).toBe(401);
  });
});
