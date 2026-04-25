import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerCampaignCallback,
  resetCampaignCallbackRegistryForTests,
} from "../campaign-callback-registry.js";
import { createSesInboundAdapter } from "./adapter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSnsFixture(name: string): Buffer {
  const base = name.endsWith(".json") ? name.slice(0, -5) : name;
  return readFileSync(join(__dirname, "../__fixtures__/ses", `${base}.json`));
}

describe("SesInboundAdapter", () => {
  beforeEach(() => {
    resetCampaignCallbackRegistryForTests();
    registerCampaignCallback(
      "c_test_1",
      "org_1",
      "http://127.0.0.1:19999/api/webhooks/campaign-analytics/test"
    );
  });

  it("parses delivery notification and maps to delivered", () => {
    const adapter = createSesInboundAdapter({ verify: async () => true });
    const buf = loadSnsFixture("delivery-notification");
    const items = adapter.parseEvents(buf);
    expect(items).toHaveLength(1);
    const inner = items[0] as Record<string, unknown>;
    const c = adapter.extractCorrelation(inner)!;
    expect(c.campaign_id).toBe("c_test_1");
    const stripped = adapter.stripPii(inner);
    const std = adapter.toStandardEvent(stripped, {
      ...c,
      analytics_callback_url: "http://127.0.0.1:19999/api/webhooks/campaign-analytics/test",
    });
    expect(std?.event).toBe("delivered");
    expect(std?.provider).toBe("ses");
  });

  it("parseEvents returns empty for SNS SubscriptionConfirmation outer envelope", () => {
    const adapter = createSesInboundAdapter({ verify: async () => true });
    const items = adapter.parseEvents(loadSnsFixture("subscription-confirmation"));
    expect(items).toHaveLength(0);
  });

  it("maps SES Subscription event to unsubscribed with ses_subscription metadata", () => {
    const adapter = createSesInboundAdapter({ verify: async () => true });
    const buf = loadSnsFixture("subscription-event-notification");
    const items = adapter.parseEvents(buf);
    expect(items).toHaveLength(1);
    const inner = items[0] as Record<string, unknown>;
    const c = adapter.extractCorrelation(inner)!;
    const stripped = adapter.stripPii(inner);
    expect(stripped.subscription).toBeUndefined();
    const std = adapter.toStandardEvent(stripped, {
      ...c,
      analytics_callback_url: "http://127.0.0.1:19999/api/webhooks/campaign-analytics/test",
    });
    expect(std?.event).toBe("unsubscribed");
    expect(std?.metadata?.unsubscribe_source).toBe("ses_subscription");
    expect(JSON.stringify(std)).not.toMatch(/user@example/);
  });

  it("verify delegates to injected fn", async () => {
    const verify = vi.fn().mockResolvedValue(false);
    const adapter = createSesInboundAdapter({ verify });
    await expect(
      adapter.verifySignature({
        rawBody: Buffer.from("{}"),
        headers: {},
      })
    ).resolves.toBe(false);
    expect(verify).toHaveBeenCalled();
  });
});
