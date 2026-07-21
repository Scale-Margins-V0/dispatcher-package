import { afterEach, describe, expect, it, vi } from "vitest";

const posthogCtor = vi.hoisted(() => vi.fn());

vi.mock("posthog-node", () => ({
  PostHog: posthogCtor,
}));

const OLD_ENV = { ...process.env };

async function loadTelemetry(): Promise<typeof import("./posthog.js")> {
  vi.resetModules();
  posthogCtor.mockReset();
  return import("./posthog.js");
}

describe("dispatcher telemetry", () => {
  afterEach(() => {
    process.env = { ...OLD_ENV };
    vi.resetModules();
    posthogCtor.mockReset();
  });

  it("is enabled by default with the ScaleMargin project key", async () => {
    delete process.env.POSTHOG_API_KEY;
    delete process.env.POSTHOG_HOST;
    delete process.env.DISPATCHER_TELEMETRY_DISABLED;

    const { getTelemetryStatus } = await loadTelemetry();

    expect(posthogCtor).toHaveBeenCalledWith(
      expect.stringMatching(/^phc_/),
      expect.objectContaining({
        host: "https://eu.i.posthog.com",
        enableExceptionAutocapture: false,
      })
    );
    expect(getTelemetryStatus()).toMatchObject({
      enabled: true,
      disabled_by_env: false,
      posthog_configured: true,
      posthog_host: "https://eu.i.posthog.com",
    });
  });

  it("allows POSTHOG_API_KEY and POSTHOG_HOST overrides", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    process.env.POSTHOG_HOST = "https://custom.posthog.test";
    delete process.env.DISPATCHER_TELEMETRY_DISABLED;

    const { getTelemetryStatus } = await loadTelemetry();

    expect(posthogCtor).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({
        host: "https://custom.posthog.test",
      })
    );
    expect(getTelemetryStatus()).toMatchObject({
      enabled: true,
      posthog_configured: true,
      posthog_host: "https://custom.posthog.test",
    });
  });

  it("does not create a client when disabled by env", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    process.env.DISPATCHER_TELEMETRY_DISABLED = "1";

    const { getTelemetryStatus } = await loadTelemetry();

    expect(posthogCtor).not.toHaveBeenCalled();
    expect(getTelemetryStatus()).toMatchObject({
      enabled: false,
      disabled_by_env: true,
      posthog_configured: true,
    });
  });

  it("uses the built-in project key when no project key is configured", async () => {
    delete process.env.POSTHOG_API_KEY;
    delete process.env.DISPATCHER_TELEMETRY_DISABLED;

    const { getTelemetryStatus } = await loadTelemetry();

    expect(posthogCtor).toHaveBeenCalled();
    expect(getTelemetryStatus()).toMatchObject({
      enabled: true,
      disabled_by_env: false,
      posthog_configured: true,
    });
  });
});
