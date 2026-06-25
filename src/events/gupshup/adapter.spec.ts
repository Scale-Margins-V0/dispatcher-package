import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createGupshupInboundAdapter,
  extractGupshupReceipt,
  normalizeGupshupInboundRecord,
} from "./adapter.js";

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

  it("verifySignature is open (accepts) when no secret configured", () => {
    const open = createGupshupInboundAdapter("");
    expect(
      open.verifySignature({ rawBody: Buffer.from("{}"), headers: {} })
    ).toBe(true);
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

  describe("GatewayAPI delivery receipts (externalId, no tag)", () => {
    const externalId = "5727636466279092270-1028021868126176";

    function loadFlat(): Record<string, unknown> {
      const raw = readFileSync(
        join(__dirname, "../__fixtures__/gupshup", "gateway-receipt.json")
      );
      return adapter.parseEvents(raw)[0] as Record<string, unknown>;
    }

    it("parses the array form and lifts externalId/eventTs into the common shape", () => {
      const raw = readFileSync(
        join(__dirname, "../__fixtures__/gupshup", "gateway-receipt.json")
      );
      const items = adapter.parseEvents(raw);
      expect(items).toHaveLength(1);
      const flat = items[0] as Record<string, unknown>;
      expect(flat.eventType).toBe("FAILED");
      expect(flat.msgId).toBe(externalId);
      expect(flat.externalId).toBe(externalId);
      expect(flat.cause).toBe("WA_FrequencyCapping");
      expect(flat.errorCode).toBe("121");
      expect(flat.timestamp).toBe("2026-06-24T11:05:07.000Z");
    });

    it("extractCorrelation returns null for a receipt (no tag → correlated on backend)", () => {
      expect(adapter.extractCorrelation(loadFlat())).toBeNull();
    });

    it("extractGupshupReceipt builds a forwardable receipt with mapped event + cause", () => {
      const receipt = extractGupshupReceipt(loadFlat());
      expect(receipt).toEqual({
        external_id: externalId,
        event: "failed",
        occurred_at: "2026-06-24T11:05:07.000Z",
        cause: "WA_FrequencyCapping",
        error_code: "121",
      });
    });

    it("extractGupshupReceipt returns null when there is no external id", () => {
      expect(extractGupshupReceipt({ eventType: "READ" })).toBeNull();
    });

    it("drops the recipient phone (destAddr) from the stripped event", () => {
      const stripped = adapter.stripPii(loadFlat());
      expect(stripped.destination).toBeUndefined();
    });
  });
});
