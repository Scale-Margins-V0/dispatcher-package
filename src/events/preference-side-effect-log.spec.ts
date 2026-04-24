import { afterEach, describe, expect, it, vi } from "vitest";
import { logPreferenceSideEffectSimulation } from "./preference-side-effect-log.js";

describe("logPreferenceSideEffectSimulation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("logs unsubscribed with correlation + metadata only", () => {
    vi.stubEnv("EVENT_PREFERENCE_SIMULATION_LOG", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logPreferenceSideEffectSimulation({
      campaign_id: "c1",
      user_id: "u1",
      organization_id: "o1",
      channel: "email",
      event: "unsubscribed",
      provider: "sendgrid",
      provider_message_id: "mid",
      occurred_at: "2020-01-02T03:04:05.000Z",
      metadata: { unsubscribe_source: "global", provider_event_id: "e1" },
    });
    expect(log).toHaveBeenCalledTimes(1);
    const msg = String(log.mock.calls[0]?.[0]);
    expect(msg).toContain("[Events][PreferenceSimulation]");
    expect(msg).toContain('"user_id":"u1"');
    expect(msg).toContain("preference_side_effect_simulation");
  });

  it("skips when EVENT_PREFERENCE_SIMULATION_LOG=0", () => {
    vi.stubEnv("EVENT_PREFERENCE_SIMULATION_LOG", "0");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logPreferenceSideEffectSimulation({
      campaign_id: "c1",
      user_id: "u1",
      organization_id: "o1",
      channel: "email",
      event: "unsubscribed",
      provider: "sendgrid",
      provider_message_id: "mid",
      occurred_at: "2020-01-02T03:04:05.000Z",
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("ignores delivered", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logPreferenceSideEffectSimulation({
      campaign_id: "c1",
      user_id: "u1",
      organization_id: "o1",
      channel: "email",
      event: "delivered",
      provider: "sendgrid",
      provider_message_id: "mid",
      occurred_at: "2020-01-02T03:04:05.000Z",
    });
    expect(log).not.toHaveBeenCalled();
  });
});
