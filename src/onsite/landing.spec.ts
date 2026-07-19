import { describe, expect, it } from "vitest";
import { buildLandingUrl } from "./landing.js";

describe("buildLandingUrl", () => {
  it("appends allowlisted UTM values and puts the token in the fragment", () => {
    const url = buildLandingUrl(
      "https://go.example/o",
      { source: "sm", medium: "email", campaign: "spring" },
      "TOK123"
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("utm_source")).toBe("sm");
    expect(parsed.searchParams.get("utm_medium")).toBe("email");
    expect(parsed.searchParams.get("utm_campaign")).toBe("spring");
    expect(parsed.hash).toBe("#sm_t=TOK123");
  });

  it("drops non-allowlisted attribution keys", () => {
    const url = buildLandingUrl(
      "https://go.example/o",
      { source: "sm", gclid: "secret", internal_flag: "x" } as never,
      "TOK"
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("utm_source")).toBe("sm");
    expect(parsed.searchParams.has("gclid")).toBe(false);
    expect(parsed.searchParams.has("internal_flag")).toBe(false);
  });

  it("preserves an existing query on the landing_url", () => {
    const url = buildLandingUrl(
      "https://go.example/o?ref=1",
      { source: "sm" },
      "TOK"
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("ref")).toBe("1");
    expect(parsed.searchParams.get("utm_source")).toBe("sm");
    expect(parsed.hash).toBe("#sm_t=TOK");
  });
});
