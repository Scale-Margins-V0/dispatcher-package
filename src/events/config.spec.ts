import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  loadEventsConfigFromYaml,
  assertEventsConfigEnv,
  mergeEventsEnvOverrides,
  resetEventsConfigForTests,
  logResolvedEventsConfig,
} from "./config.js";

const validYaml = `
events:
  forward:
    mode: sync
    batch_size: 50
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
      enabled: true
      configuration_set_env: SES_EVENT_CONFIG_SET
    gupshup:
      enabled: false
      secret_env: GUPSHUP_WEBHOOK_SECRET
`;

describe("events/config", () => {
  beforeEach(() => {
    resetEventsConfigForTests();
  });
  afterEach(() => {
    resetEventsConfigForTests();
  });

  it("parses valid YAML", () => {
    const cfg = loadEventsConfigFromYaml(validYaml);
    expect(cfg.forward.mode).toBe("sync");
    expect(cfg.delivery.mode).toBe("best_effort");
    expect(cfg.providers.sendgrid.enabled).toBe(true);
  });

  it("rejects unknown forward mode", () => {
    expect(() =>
      loadEventsConfigFromYaml(validYaml.replace("sync", "invalid"))
    ).toThrow();
  });

  it("assertEventsConfigEnv requires SendGrid key when enabled", () => {
    const cfg = loadEventsConfigFromYaml(validYaml);
    delete process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
    expect(() => assertEventsConfigEnv(cfg)).toThrow(/SendGrid/);
  });

  it("assertEventsConfigEnv passes when SendGrid key set", () => {
    const cfg = loadEventsConfigFromYaml(validYaml);
    process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEtest=";
    expect(() => assertEventsConfigEnv(cfg)).not.toThrow();
    delete process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
  });

  it("assertEventsConfigEnv keeps gupshup open (enabled) when secret missing", () => {
    const yaml = validYaml
      .replace("sendgrid:\n      enabled: true", "sendgrid:\n      enabled: false")
      .replace("gupshup:\n      enabled: false", "gupshup:\n      enabled: true");
    const cfg = loadEventsConfigFromYaml(yaml);
    delete process.env.GUPSHUP_WEBHOOK_SECRET;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => assertEventsConfigEnv(cfg)).not.toThrow();
    expect(cfg.providers.gupshup.enabled).toBe(true);
    expect(warn.mock.calls[0]?.[0]).toMatch(/Gupshup inbound webhook is OPEN/);
    warn.mockRestore();
  });

  it("parses sendgrid inbound_event_types", () => {
    const yaml = validYaml.replace(
      "signing_key_env: SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY",
      "signing_key_env: SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY\n      inbound_event_types: [delivered, open]"
    );
    const cfg = loadEventsConfigFromYaml(yaml);
    expect(cfg.providers.sendgrid.inbound_event_types).toEqual(["delivered", "open"]);
  });

  it("mergeEventsEnvOverrides sets EVENT_SENDGRID_INBOUND_EVENTS", () => {
    const cfg = loadEventsConfigFromYaml(validYaml);
    process.env.EVENT_SENDGRID_INBOUND_EVENTS = "delivered,open";
    mergeEventsEnvOverrides(cfg);
    expect(cfg.providers.sendgrid.inbound_event_types).toEqual(["delivered", "open"]);
    process.env.EVENT_SENDGRID_INBOUND_EVENTS = "*";
    mergeEventsEnvOverrides(cfg);
    expect(cfg.providers.sendgrid.inbound_event_types).toEqual(["*"]);
    process.env.EVENT_SENDGRID_INBOUND_EVENTS = "default";
    mergeEventsEnvOverrides(cfg);
    expect(cfg.providers.sendgrid.inbound_event_types).toBeUndefined();
    delete process.env.EVENT_SENDGRID_INBOUND_EVENTS;
  });

  it("mergeEventsEnvOverrides disables sendgrid when EVENT_PROVIDERS_DISABLED lists it", () => {
    process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY =
      "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEtest=";
    process.env.EVENT_PROVIDERS_DISABLED = "sendgrid";
    const cfg = loadEventsConfigFromYaml(validYaml);
    mergeEventsEnvOverrides(cfg);
    expect(cfg.providers.sendgrid.enabled).toBe(false);
    delete process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
    delete process.env.EVENT_PROVIDERS_DISABLED;
  });

  it("mergeEventsEnvOverrides enables sendgrid from signing key when not disabled", () => {
    process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY =
      "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEtest=";
    delete process.env.EVENT_PROVIDERS_DISABLED;
    const cfg = loadEventsConfigFromYaml(
      validYaml.replace("enabled: true", "enabled: false")
    );
    mergeEventsEnvOverrides(cfg);
    expect(cfg.providers.sendgrid.enabled).toBe(true);
    delete process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
  });

  it("logResolvedEventsConfig logs JSON when EVENT_DEBUG=1", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.EVENT_DEBUG = "1";
    const cfg = loadEventsConfigFromYaml(validYaml);
    logResolvedEventsConfig(cfg);
    expect(log.mock.calls[0]?.[0]).toContain("[Events] resolved config");
    log.mockRestore();
    delete process.env.EVENT_DEBUG;
  });
});
