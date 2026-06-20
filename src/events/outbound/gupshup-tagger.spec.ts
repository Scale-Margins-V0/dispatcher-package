import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { applyGupshupTag } from "./gupshup-tagger.js";

describe("applyGupshupTag", () => {
  it("builds JSON tag with correlation fields", () => {
    const tagged = applyGupshupTag({}, {
      campaign_id: "c1",
      user_id: "u1",
      dispatch_id: "d1",
      organization_id: "o1",
      analytics_callback_url: "https://example.com/cb",
    });
    expect(JSON.parse(tagged.tag)).toEqual({
      campaign_id: "c1",
      user_id: "u1",
      dispatch_id: "d1",
      organization_id: "o1",
      analytics_callback_url: "https://example.com/cb",
    });
  });
});
