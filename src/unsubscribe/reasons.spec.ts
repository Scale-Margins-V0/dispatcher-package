import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getUnsubscribeReasons,
  resolveUnsubscribeReasonText,
} from "./reasons.js";

describe("unsubscribe reasons", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns built-in defaults when UNSUBSCRIBE_REASONS is unset", () => {
    delete process.env.UNSUBSCRIBE_REASONS;
    const reasons = getUnsubscribeReasons();
    expect(reasons.length).toBeGreaterThanOrEqual(3);
    expect(reasons.some((r) => r.allowCustom)).toBe(true);
    expect(reasons.map((r) => r.label)).toContain(
      "This email is not relevant to me"
    );
    expect(reasons.map((r) => r.label)).toContain(
      "I find these emails inappropriate or spam"
    );
  });

  it("parses pipe-separated labels", () => {
    vi.stubEnv(
      "UNSUBSCRIBE_REASONS",
      "Too many emails|Not interested|Other"
    );
    const reasons = getUnsubscribeReasons();
    expect(reasons).toHaveLength(3);
    expect(reasons[0]?.label).toBe("Too many emails");
    expect(reasons[2]?.allowCustom).toBe(true);
  });

  it("parses id=label pairs", () => {
    vi.stubEnv(
      "UNSUBSCRIBE_REASONS",
      "freq=Too frequent|spam=Looks like spam|other=Tell us more"
    );
    const reasons = getUnsubscribeReasons();
    expect(reasons.map((r) => r.id)).toEqual(["freq", "spam", "other"]);
    expect(reasons[2]?.allowCustom).toBe(true);
    expect(reasons[2]?.label).toBe("Tell us more");
  });

  it("parses JSON array of strings", () => {
    vi.stubEnv(
      "UNSUBSCRIBE_REASONS",
      JSON.stringify(["Reason A", "Reason B", "Other"])
    );
    const reasons = getUnsubscribeReasons();
    expect(reasons).toHaveLength(3);
    expect(reasons[2]?.allowCustom).toBe(true);
  });

  it("resolves preset reason text", () => {
    delete process.env.UNSUBSCRIBE_REASONS;
    const resolved = resolveUnsubscribeReasonText({
      reasonId: "too_frequent",
      otherText: undefined,
    });
    expect(resolved).toEqual({
      reasonId: "too_frequent",
      reason: "The emails are too frequent",
    });
  });

  it("prefers free-text for other", () => {
    delete process.env.UNSUBSCRIBE_REASONS;
    const resolved = resolveUnsubscribeReasonText({
      reasonId: "other",
      otherText: "  switched jobs  ",
    });
    expect(resolved).toEqual({
      reasonId: "other",
      reason: "switched jobs",
    });
  });
});
