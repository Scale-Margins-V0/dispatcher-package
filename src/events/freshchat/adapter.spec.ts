import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createFreshchatInboundAdapter,
  extractFreshchatReceipt,
  mapFreshchatStatus,
  normalizeFreshchatInboundRecord,
} from "./adapter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const secret = "test-freshchat-secret";

function signBody(buf: Buffer): string {
  return createHmac("sha256", secret).update(buf).digest("hex");
}

describe("FreshchatInboundAdapter", () => {
  const adapter = createFreshchatInboundAdapter(secret);

  it("mapFreshchatStatus maps statuses properly", () => {
    expect(mapFreshchatStatus("ACCEPTED")).toBe("dispatched");
    expect(mapFreshchatStatus("SENT")).toBe("dispatched");
    expect(mapFreshchatStatus("DELIVERED")).toBe("delivered");
    expect(mapFreshchatStatus("READ")).toBe("read");
    expect(mapFreshchatStatus("FAILED")).toBe("bounced");
    expect(mapFreshchatStatus("UNDELIVERED")).toBe("bounced");
    expect(mapFreshchatStatus("UNKNOWN_XYZ")).toBeNull();
  });

  it("verifySignature accepts valid X-Freshchat-Signature header", () => {
    const buf = readFileSync(join(__dirname, "../__fixtures__/freshchat", "delivered.json"));
    const ok = adapter.verifySignature({
      rawBody: buf,
      headers: { "x-freshchat-signature": signBody(buf) },
    });
    expect(ok).toBe(true);
  });

  it("verifySignature accepts Bearer token Authorization header", () => {
    const buf = readFileSync(join(__dirname, "../__fixtures__/freshchat", "delivered.json"));
    const ok = adapter.verifySignature({
      rawBody: buf,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(ok).toBe(true);
  });

  it("verifySignature is open (accepts) when no secret configured", () => {
    const open = createFreshchatInboundAdapter("");
    expect(
      open.verifySignature({ rawBody: Buffer.from("{}"), headers: {} })
    ).toBe(true);
  });

  it("verifySignature rejects invalid signature", () => {
    const buf = Buffer.from("{}");
    expect(
      adapter.verifySignature({
        rawBody: buf,
        headers: { "x-freshchat-signature": "deadbeef" },
      })
    ).toBe(false);
  });

  it("parses wrapped outbound_message_event and extracts receipt", () => {
    const raw = readFileSync(join(__dirname, "../__fixtures__/freshchat", "delivered.json"));
    const items = adapter.parseEvents(raw);
    expect(items).toHaveLength(1);

    const receipt = extractFreshchatReceipt(items[0]);
    expect(receipt).not.toBeNull();
    expect(receipt?.external_id).toBe("fc-req-12345");
    expect(receipt?.event).toBe("delivered");
    expect(receipt?.occurred_at).toBe("2024-08-26T10:24:50.000Z");
  });

  it("parses read status event and maps event to read", () => {
    const raw = readFileSync(join(__dirname, "../__fixtures__/freshchat", "read.json"));
    const items = adapter.parseEvents(raw);
    const receipt = extractFreshchatReceipt(items[0]);
    expect(receipt?.external_id).toBe("fc-req-12345");
    expect(receipt?.event).toBe("read");
  });

  it("parses failed event and includes failure cause and error_code", () => {
    const raw = readFileSync(join(__dirname, "../__fixtures__/freshchat", "failed.json"));
    const items = adapter.parseEvents(raw);
    const receipt = extractFreshchatReceipt(items[0]);
    expect(receipt?.external_id).toBe("fc-req-failed-99");
    expect(receipt?.event).toBe("bounced");
    expect(receipt?.cause).toBe("Marketing frequency cap reached");
    expect(receipt?.error_code).toBe("4131");
  });

  it("parses flat event payload", () => {
    const raw = readFileSync(join(__dirname, "../__fixtures__/freshchat", "flat-event.json"));
    const items = adapter.parseEvents(raw);
    const receipt = extractFreshchatReceipt(items[0]);
    expect(receipt?.external_id).toBe("fc-req-flat-1");
    expect(receipt?.event).toBe("delivered");
  });

  it("stripPii removes phone numbers and contact details", () => {
    const raw = JSON.parse(
      readFileSync(join(__dirname, "../__fixtures__/freshchat", "delivered.json"), "utf-8")
    );
    const stripped = adapter.stripPii(raw);
    expect(stripped.phone_number).toBeUndefined();
    expect(stripped.to).toBeUndefined();
    expect(stripped.from).toBeUndefined();
    expect(stripped.externalId).toBe("fc-req-12345");
  });
});
