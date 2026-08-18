import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCapturedLogs, findCapturedLogs } from "../logging/test-capture.js";
import { logPreferenceSideEffectSimulation } from "./preference-side-effect-log.js";

describe("logPreferenceSideEffectSimulation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("logs unsubscribed with correlation + metadata only", () => {
    vi.stubEnv("EVENT_PREFERENCE_SIMULATION_LOG", "1");
    clearCapturedLogs();
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
    const entries = findCapturedLogs((e) => e.fields.simulated === true);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.fields).toMatchObject({
      user_id: "u1",
      campaign_id: "c1",
      kind: "preference_side_effect_simulation",
    });
  });

  it("skips when EVENT_PREFERENCE_SIMULATION_LOG=0", () => {
    vi.stubEnv("EVENT_PREFERENCE_SIMULATION_LOG", "0");
    clearCapturedLogs();
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
    expect(findCapturedLogs((e) => e.fields.simulated === true)).toHaveLength(0);
  });

  it("ignores delivered", () => {
    clearCapturedLogs();
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
    expect(findCapturedLogs((e) => e.fields.simulated === true)).toHaveLength(0);
  });
});
