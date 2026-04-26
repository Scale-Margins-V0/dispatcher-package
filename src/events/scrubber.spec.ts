import { describe, expect, it } from "vitest";
import { scrubPii } from "./scrubber.js";

describe("scrubPii", () => {
  it("redacts nested email, IPv4, phone in metadata", () => {
    const input = {
      metadata: {
        reason: "550 5.1.1 user@evil.com unknown",
        note: "call +1 (415) 555-0199 soon",
        ip: "10.0.0.1",
      },
      safe: "campaign-ok",
    };
    const out = scrubPii(input);
    expect(JSON.stringify(out)).not.toMatch(/user@evil/);
    expect(JSON.stringify(out)).not.toMatch(/415/);
    expect(JSON.stringify(out)).not.toMatch(/10\.0\.0\.1/);
    expect(out.safe).toBe("campaign-ok");
  });

  it("preserves non-PII strings", () => {
    expect(scrubPii({ a: "hello world" })).toEqual({ a: "hello world" });
  });

  it("regression: email hidden in bounce_reason survives adapter strip", () => {
    const afterAdapter = {
      bounce_reason: "smtp; 550 5.1.1 victim@company.test over quota",
    };
    const out = scrubPii(afterAdapter);
    expect(out.bounce_reason).not.toContain("victim@");
    expect(out.bounce_reason).toContain("[REDACTED]");
  });
});
