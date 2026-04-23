import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSendGridInboundAdapter } from "./sendgrid.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function load(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(__dirname, "../__fixtures__/sendgrid", `${name}.json`), "utf-8")
  ) as Record<string, unknown>;
}

describe("SendGridInboundAdapter", () => {
  const adapter = createSendGridInboundAdapter(
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g=="
  );

  it("maps delivered to delivered with correlation", () => {
    const raw = load("delivered");
    const c = adapter.extractCorrelation(raw)!;
    const stripped = adapter.stripPii(raw);
    const std = adapter.toStandardEvent(stripped, { ...c, analytics_callback_url: "http://x" });
    expect(std?.event).toBe("delivered");
    expect(std?.user_id).toBe("u_42");
    expect(std?.provider_message_id).toBeTruthy();
    expect(JSON.stringify(std)).not.toMatch(/recipient@/);
  });

  it("maps processed to dispatched", () => {
    const raw = load("processed");
    const c = adapter.extractCorrelation(raw)!;
    const std = adapter.toStandardEvent(adapter.stripPii(raw), {
      ...c,
      analytics_callback_url: "http://x",
    });
    expect(std?.event).toBe("dispatched");
  });

  it("returns null correlation when custom_args missing", () => {
    expect(adapter.extractCorrelation(load("missing-correlation"))).toBeNull();
  });

  it("parseEvents + extractCorrelation from raw JSON buffer (integration-style)", () => {
    const buf = Buffer.from(
      JSON.stringify([load("delivered")]) + "\r\n",
      "utf-8"
    );
    const items = adapter.parseEvents(buf);
    expect(items).toHaveLength(1);
    expect(adapter.extractCorrelation(items[0])).not.toBeNull();
  });

  it("verify rejects bad signature", () => {
    const ok = adapter.verifySignature({
      rawBody: Buffer.from("[{}]"),
      headers: {
        "x-twilio-email-event-webhook-signature": "not-a-valid-signature",
        "x-twilio-email-event-webhook-timestamp": "1",
      },
    });
    expect(ok).toBe(false);
  });
});
