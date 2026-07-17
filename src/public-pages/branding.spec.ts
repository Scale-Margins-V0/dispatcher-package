import { afterEach, describe, expect, it, vi } from "vitest";
import { getLogoUrl, renderLogoHtml } from "./branding.js";

describe("public page branding", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns undefined when LOGO_URL is unset", () => {
    delete process.env.LOGO_URL;
    expect(getLogoUrl()).toBeUndefined();
    expect(renderLogoHtml()).toBe("");
  });

  it("accepts http(s) logo URLs", () => {
    vi.stubEnv("LOGO_URL", "https://cdn.example.com/logo.png");
    expect(getLogoUrl()).toBe("https://cdn.example.com/logo.png");
    expect(renderLogoHtml()).toContain('src="https://cdn.example.com/logo.png"');
  });

  it("rejects non-http logo URLs", () => {
    vi.stubEnv("LOGO_URL", "javascript:alert(1)");
    expect(getLogoUrl()).toBeUndefined();
  });
});
