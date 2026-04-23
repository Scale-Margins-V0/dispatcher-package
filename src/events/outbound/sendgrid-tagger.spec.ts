import { describe, expect, it } from "vitest";
import { applySendGridCustomArgs } from "./sendgrid-tagger.js";

describe("applySendGridCustomArgs", () => {
  it("adds customArgs without removing other fields", () => {
    const msg = applySendGridCustomArgs(
      { to: "a@b.com", from: "x@y.com", subject: "s", html: "<p/>" },
      {
        campaign_id: "c1",
        user_id: "u1",
        organization_id: "o1",
        analytics_callback_url: "http://127.0.0.1:9/api/webhooks/campaign-analytics/x",
      }
    );
    expect(msg.customArgs).toEqual({
      campaign_id: "c1",
      user_id: "u1",
      organization_id: "o1",
      analytics_callback_url: "http://127.0.0.1:9/api/webhooks/campaign-analytics/x",
    });
    expect((msg as { to: string }).to).toBe("a@b.com");
  });
});
