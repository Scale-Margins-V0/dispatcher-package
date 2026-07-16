import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverLogWebhook, logWebhookSink, payloadFromLine } from "./webhook-sink.js";
import { resetLogWebhookConfigForTests, setLogWebhookConfigForTests } from "./webhook-config.js";

const line = (level: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ level, time: Date.now(), msg: `msg-${level}`, component: "test", ...extra });

beforeEach(() => {
  resetLogWebhookConfigForTests();
  // The sink no-ops under VITEST by design; exercise its real path in tests.
  delete process.env.VITEST;
});

afterEach(() => {
  process.env.VITEST = "true";
  resetLogWebhookConfigForTests();
  vi.restoreAllMocks();
});

describe("deliverLogWebhook", () => {
  it("POSTs the payload and signs it when a secret is set", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    const payload = payloadFromLine({ level: 50, time: Date.now(), msg: "boom", component: "x" });
    const r = await deliverLogWebhook({ enabled: true, url: "https://sink.example/logs", levels: ["warn", "error", "fatal"], secret: "s3cret" }, payload);
    expect(r.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = (init as RequestInit).body as string;
    const sig = (init as RequestInit).headers as Record<string, string>;
    expect(sig["x-dispatcher-log-signature"]).toBe(
      "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex")
    );
  });

  it("reports non-2xx as not ok", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no", { status: 500 }));
    const r = await deliverLogWebhook(
      { enabled: true, url: "https://sink.example/logs", levels: ["warn", "error", "fatal"] },
      payloadFromLine({ level: 50, msg: "x" })
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
  });

  it("rejects a non-http url", async () => {
    const r = await deliverLogWebhook(
      { enabled: true, url: "ftp://nope", levels: ["warn", "error", "fatal"] },
      payloadFromLine({ level: 50, msg: "x" })
    );
    expect(r.ok).toBe(false);
  });
});

describe("LogWebhookSink.write", () => {
  it("does nothing when disabled", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    setLogWebhookConfigForTests({ enabled: false, url: "https://x/y", levels: ["info"] });
    logWebhookSink.write(line(50));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards only the selected log levels", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    setLogWebhookConfigForTests({ enabled: true, url: "https://x/y", levels: ["warn", "error"] });
    logWebhookSink.write(line(30)); // info — skipped
    logWebhookSink.write(line(40)); // warn — forwarded
    logWebhookSink.write(line(50)); // error — forwarded
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caps in-flight and drops the overflow", () => {
    // fetch never resolves → in-flight stays pinned
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    setLogWebhookConfigForTests({ enabled: true, url: "https://x/y", levels: ["info", "warn", "error", "fatal"] });
    for (let i = 0; i < 20; i++) logWebhookSink.write(line(40));
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5);
  });
});
