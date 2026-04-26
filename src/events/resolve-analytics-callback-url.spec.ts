import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  registerCampaignCallback,
  resetCampaignCallbackRegistryForTests,
} from "./campaign-callback-registry.js";
import {
  resolveAnalyticsCallbackUrl,
  SCALEMARGIN_ANALYTICS_CALLBACK_URL_ENV,
  SCALEMARGIN_ANALYTICS_CALLBACK_URL_OVERRIDES_DISPATCH_ENV,
} from "./resolve-analytics-callback-url.js";

describe("resolveAnalyticsCallbackUrl", () => {
  beforeEach(() => {
    resetCampaignCallbackRegistryForTests();
    delete process.env[SCALEMARGIN_ANALYTICS_CALLBACK_URL_ENV];
    delete process.env[SCALEMARGIN_ANALYTICS_CALLBACK_URL_OVERRIDES_DISPATCH_ENV];
  });
  afterEach(() => {
    resetCampaignCallbackRegistryForTests();
    delete process.env[SCALEMARGIN_ANALYTICS_CALLBACK_URL_ENV];
    delete process.env[SCALEMARGIN_ANALYTICS_CALLBACK_URL_OVERRIDES_DISPATCH_ENV];
  });

  it("prefers correlation URL when override is off", () => {
    process.env[SCALEMARGIN_ANALYTICS_CALLBACK_URL_ENV] =
      "http://localhost:5600/api/webhooks/campaign-analytics";
    const u = resolveAnalyticsCallbackUrl({
      campaignId: "c1",
      correlationCallbackUrl: "https://api.example.com/api/webhooks/campaign-analytics",
    });
    expect(u).toBe("https://api.example.com/api/webhooks/campaign-analytics");
  });

  it("prefers env URL when SCALEMARGIN_ANALYTICS_CALLBACK_URL_OVERRIDES_DISPATCH=1", () => {
    process.env[SCALEMARGIN_ANALYTICS_CALLBACK_URL_ENV] =
      "http://localhost:5600/api/webhooks/campaign-analytics";
    process.env[SCALEMARGIN_ANALYTICS_CALLBACK_URL_OVERRIDES_DISPATCH_ENV] = "1";
    const u = resolveAnalyticsCallbackUrl({
      campaignId: "c1",
      correlationCallbackUrl: "https://api.scalemargins.tech/api/webhooks/campaign-analytics",
    });
    expect(u).toBe("http://localhost:5600/api/webhooks/campaign-analytics");
  });

  it("uses registry when no correlation and no override", () => {
    registerCampaignCallback(
      "c-reg",
      "org",
      "http://127.0.0.1:5600/api/webhooks/campaign-analytics"
    );
    const u = resolveAnalyticsCallbackUrl({ campaignId: "c-reg" });
    expect(u).toBe("http://127.0.0.1:5600/api/webhooks/campaign-analytics");
  });
});
