import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { applyGupshupTag } from "./gupshup-tagger.js";
import { SMSIGN_MAX_WIRE_LEN, SMSIGN_PREFIX } from "../tag-sign.js";

const ctx = {
  campaign_id: "c1",
  user_id: "u1",
  dispatch_id: "d1",
  organization_id: "o1",
  analytics_callback_url: "https://example.com/cb",
};

describe("applyGupshupTag", () => {
  afterEach(() => {
    delete process.env.SCALEMARGIN_ANALYTICS_SECRET;
  });

  it("falls back to JSON tag when no signing secret is configured", () => {
    delete process.env.SCALEMARGIN_ANALYTICS_SECRET;
    const tagged = applyGupshupTag({}, ctx);
    expect(JSON.parse(tagged.tag)).toEqual({
      campaign_id: "c1",
      user_id: "u1",
      dispatch_id: "d1",
      organization_id: "o1",
      analytics_callback_url: "https://example.com/cb",
    });
  });

  describe("with signing secret", () => {
    beforeEach(() => {
      process.env.SCALEMARGIN_ANALYTICS_SECRET = "s3cret";
    });

    it("emits a smsign_ token within the 50-char extra limit", () => {
      const { tag } = applyGupshupTag({}, ctx);
      expect(tag.startsWith(SMSIGN_PREFIX)).toBe(true);
      expect(tag.length).toBeLessThanOrEqual(SMSIGN_MAX_WIRE_LEN);
    });

    it("is deterministic for the same tuple and differs across users", () => {
      const a = applyGupshupTag({}, ctx).tag;
      const b = applyGupshupTag({}, ctx).tag;
      const other = applyGupshupTag({}, { ...ctx, user_id: "u2" }).tag;
      expect(a).toBe(b);
      expect(a).not.toBe(other);
    });
  });
});
