import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createGupshupInboundAdapter, normalizeGupshupInboundRecord } from "./adapter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const secret = "test-secret";

function signBody(buf: Buffer): string {
  return createHmac("sha256", secret).update(buf).digest("hex");
}

describe("GupshupInboundAdapter", () => {
  const adapter = createGupshupInboundAdapter(secret);

  it("maps enqueued to dispatched", () => {
    const raw = JSON.parse(
      readFileSync(join(__dirname, "../__fixtures__/gupshup", "enqueued.json"), "utf-8")
    ) as Record<string, unknown>;
    const c = adapter.extractCorrelation(raw)!;
    const std = adapter.toStandardEvent(adapter.stripPii(raw), {
      ...c,
      analytics_callback_url: "http://x",
    });
    expect(std?.event).toBe("dispatched");
    expect(std?.channel).toBe("whatsapp");
  });

  it("verifySignature accepts valid HMAC", () => {
    const buf = readFileSync(join(__dirname, "../__fixtures__/gupshup", "read.json"));
    const ok = adapter.verifySignature({
      rawBody: buf,
      headers: { "x-gupshup-signature": signBody(buf) },
    });
    expect(ok).toBe(true);
  });

  it("verifySignature rejects bad HMAC", () => {
    const buf = Buffer.from("{}");
    expect(
      adapter.verifySignature({
        rawBody: buf,
        headers: { "x-gupshup-signature": "deadbeef" },
      })
    ).toBe(false);
  });

  it("parseEvents normalizes v2 message-event and correlates tag", () => {
    const raw = readFileSync(join(__dirname, "../__fixtures__/gupshup", "v2-enqueued.json"));
    const items = adapter.parseEvents(raw);
    expect(items).toHaveLength(1);
    const flat = items[0] as Record<string, unknown>;
    expect(flat.eventType).toBe("enqueued");
    expect(flat.msgId).toBe("ee4a68a0-1203-4c85-8dc3-49d0b3226a35");
    const c = adapter.extractCorrelation(flat);
    expect(c?.campaign_id).toBe("c_v2");
    expect(c?.user_id).toBe("u_v2");
    expect(c?.organization_id).toBe("org_v2");
  });

  it("normalizeGupshupInboundRecord leaves legacy payloads unchanged", () => {
    const legacy = JSON.parse(
      readFileSync(join(__dirname, "../__fixtures__/gupshup", "read.json"), "utf-8")
    ) as Record<string, unknown>;
    expect(normalizeGupshupInboundRecord(legacy)).toBe(legacy);
  });
});
