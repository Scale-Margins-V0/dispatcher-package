import { describe, expect, it } from "vitest";
import { applyOnsiteUrl, contentReferencesOnsite } from "./issue.js";

describe("contentReferencesOnsite", () => {
  it("detects the placeholder in email fields and the WhatsApp caption", () => {
    expect(
      contentReferencesOnsite({ html_body: "<a>{{onsite_url}}</a>" })
    ).toBe(true);
    expect(contentReferencesOnsite({ subject: "Open {{ onsite_url }}" })).toBe(
      true
    );
    expect(contentReferencesOnsite({ text_body: "go: {{onsite_url}}" })).toBe(
      true
    );
    expect(contentReferencesOnsite({ caption: "See {{onsite_url}}" })).toBe(
      true
    );
    expect(
      contentReferencesOnsite({
        cta_value: "https://example.com/click?t={{onsite_url}}",
      })
    ).toBe(true);
    expect(
      contentReferencesOnsite({
        cta_values: [
          "https://example.com/static",
          "https://example.com/click?t={{onsite_url}}",
        ],
      })
    ).toBe(true);
  });

  it("is false when absent", () => {
    expect(
      contentReferencesOnsite({ html_body: "<a>{{unsubscribe_url}}</a>" })
    ).toBe(false);
    expect(
      contentReferencesOnsite({
        cta_value: "https://example.com/static",
        cta_values: ["https://example.com/1", "https://example.com/2"],
      })
    ).toBe(false);
    expect(contentReferencesOnsite(undefined)).toBe(false);
  });
});

describe("applyOnsiteUrl", () => {
  it("replaces every occurrence with the URL", () => {
    const out = applyOnsiteUrl(
      "a {{onsite_url}} b {{onsite_url}}",
      "https://go.example/x#sm_t=T"
    );
    expect(out).toBe(
      "a https://go.example/x#sm_t=T b https://go.example/x#sm_t=T"
    );
  });

  it("strips the placeholder when the URL is null so it never ships literally", () => {
    expect(applyOnsiteUrl("go {{onsite_url}} now", null)).toBe("go  now");
  });

  it("leaves content without the placeholder untouched", () => {
    expect(applyOnsiteUrl("no token here", "https://go.example")).toBe(
      "no token here"
    );
  });
});
