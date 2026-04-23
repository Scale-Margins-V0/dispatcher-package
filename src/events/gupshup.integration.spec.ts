/**
 * Gupshup inbound webhook (HMAC + fetch mock).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
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
import {
  initializeEventPipeline,
  resetEventPipelineForTests,
  setEventsConfigForTests,
  shutdownEventPipeline,
} from "./index.js";
import { loadEventsConfigFromYaml } from "./config.js";

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
    process.env.GUPSHUP_WEBHOOK_SECRET = secret;
    process.env.EVENT_FORWARD_MODE = "sync";
    process.env.NODE_ENV = "test";

    vi.stubGlobal("fetch", fetchMock);

    resetEventPipelineForTests();
    setEventsConfigForTests(loadEventsConfigFromYaml(yaml));

    const mod = await import("../index.js");
    app = mod.app;
    initializeEventPipeline();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    shutdownEventPipeline();
    resetEventPipelineForTests();
    delete process.env.GUPSHUP_WEBHOOK_SECRET;
    delete process.env.EVENT_FORWARD_MODE;
  });

  beforeEach(() => {
    fetchMock.mockClear();
  });

  it("verifies HMAC and forwards read event", async () => {
    const json = readFileSync(join(__dirname, "__fixtures__/gupshup", "read.json"), "utf-8");
    const sig = createHmac("sha256", secret).update(json, "utf8").digest("hex");
    const res = await request(app)
      .post("/api/scalemargin/gupshup-events")
      .set("Content-Type", "application/json")
      .set("x-gupshup-signature", sig)
      .send(json);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
  });
});
