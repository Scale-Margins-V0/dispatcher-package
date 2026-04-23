import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createSesInboundAdapter } from "./ses.js";
import { registerCampaignCallback, resetCampaignCallbackRegistryForTests } from "../campaign-callback-registry.js";

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

  it("parses delivery notification and maps to delivered", async () => {
    const adapter = createSesInboundAdapter({
      verify: async () => true,
    });
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

  it("parseEvents returns empty for subscription fixture", () => {
    const adapter = createSesInboundAdapter({ verify: async () => true });
    const items = adapter.parseEvents(loadSnsFixture("subscription-confirmation"));
    expect(items).toHaveLength(0);
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
