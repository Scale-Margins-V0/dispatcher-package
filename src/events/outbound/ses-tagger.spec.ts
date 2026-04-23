import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { applySesMessageTags, resetSesTaggerWarningsForTests } from "./ses-tagger.js";

describe("applySesMessageTags", () => {
  beforeEach(() => {
    resetSesTaggerWarningsForTests();
    delete process.env.SES_EVENT_CONFIG_SET;
  });
  afterEach(() => {
    delete process.env.SES_EVENT_CONFIG_SET;
    resetSesTaggerWarningsForTests();
  });

  it("adds Tags and ConfigurationSetName when env set", () => {
    process.env.SES_EVENT_CONFIG_SET = "my-set";
    const ctx = {
      campaign_id: "c1",
      user_id: "u1",
      organization_id: "o1",
      analytics_callback_url: "http://x",
    };
    const out = applySesMessageTags(
      {
        Source: "a@b.com",
        Destination: { ToAddresses: ["c@d.com"] },
        Message: {
          Subject: { Data: "s", Charset: "UTF-8" },
          Body: { Html: { Data: "<p/>", Charset: "UTF-8" } },
        },
      },
      ctx
    );
    expect(out.ConfigurationSetName).toBe("my-set");
    expect(out.Tags?.map((t) => t.Name)).toContain("campaign_id");
  });

  it("no ConfigurationSetName when env absent (warn once)", () => {
    const ctx = {
      campaign_id: "c1",
      user_id: "u1",
      organization_id: "o1",
      analytics_callback_url: "http://x",
    };
    const out = applySesMessageTags(
      {
        Source: "a@b.com",
        Destination: { ToAddresses: ["c@d.com"] },
        Message: {
          Subject: { Data: "s", Charset: "UTF-8" },
          Body: { Html: { Data: "<p/>", Charset: "UTF-8" } },
        },
      },
      ctx
    );
    expect(out.ConfigurationSetName).toBeUndefined();
    expect(out.Tags?.length).toBeGreaterThan(0);
  });
});
