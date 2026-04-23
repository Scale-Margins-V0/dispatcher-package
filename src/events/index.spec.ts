import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  resetEventPipelineForTests,
  setEventsConfigForTests,
  getInboundAdapter,
  isProviderEnabled,
} from "./index.js";
import { loadEventsConfigFromYaml } from "./config.js";

const minimalYaml = `
events:
  forward:
    mode: sync
    batch_size: 10
    batch_interval_ms: 1000
  delivery:
    mode: best_effort
    buffer:
      kind: memory
      max_events_memory: 50
  providers:
    sendgrid:
      enabled: true
      signing_key_env: SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY
    ses:
      enabled: true
    gupshup:
      enabled: true
      secret_env: GUPSHUP_WEBHOOK_SECRET
`;

describe("events/index facade", () => {
  beforeEach(() => {
    resetEventPipelineForTests();
    setEventsConfigForTests(loadEventsConfigFromYaml(minimalYaml));
    process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY =
      "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g==";
    process.env.GUPSHUP_WEBHOOK_SECRET = "s3cr3t";
  });
  afterEach(() => {
    resetEventPipelineForTests();
    delete process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
    delete process.env.GUPSHUP_WEBHOOK_SECRET;
  });

  it("getInboundAdapter returns sendgrid adapter", () => {
    const a = getInboundAdapter("sendgrid");
    expect(a.name).toBe("sendgrid");
    expect(a.channel).toBe("email");
  });

  it("getInboundAdapter returns gupshup when secret set", () => {
    const a = getInboundAdapter("gupshup");
    expect(a.name).toBe("gupshup");
  });

  it("isProviderEnabled reflects config", () => {
    expect(isProviderEnabled("sendgrid")).toBe(true);
  });
});
