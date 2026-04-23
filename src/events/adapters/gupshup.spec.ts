import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGupshupInboundAdapter } from "./gupshup.js";

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
});
