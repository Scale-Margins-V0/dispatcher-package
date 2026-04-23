import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildIdempotencyKey,
  buildPayloadForGroup,
  flushEnvelopesSync,
  groupEnvelopesByDestination,
  standardizedToAnalyticsEvent,
  signPayload,
} from "./forwarder.js";
import type { StandardizedEvent } from "./types.js";

function se(partial: Partial<StandardizedEvent> = {}): StandardizedEvent {
  return {
    campaign_id: "c1",
    user_id: "u1",
    organization_id: "o1",
    channel: "email",
    event: "delivered",
    provider: "sendgrid",
    provider_message_id: "mid",
    occurred_at: "2020-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("forwarder helpers", () => {
  it("buildIdempotencyKey is stable 32-char hex", () => {
    const k = buildIdempotencyKey("sendgrid", "m1", "delivered", "2020-01-01T00:00:00.000Z");
    expect(k).toHaveLength(32);
    expect(k).toMatch(/^[0-9a-f]+$/);
  });

  it("groupEnvelopesByDestination splits by url and campaign", () => {
    const g = groupEnvelopesByDestination([
      { callbackUrl: "http://a/x", event: se({ campaign_id: "c1", user_id: "u1" }) },
      { callbackUrl: "http://a/x", event: se({ campaign_id: "c1", user_id: "u2" }) },
      { callbackUrl: "http://b/y", event: se({ campaign_id: "c2" }) },
    ]);
    expect(g.size).toBe(2);
  });

  it("standardizedToAnalyticsEvent maps metadata", () => {
    const ev = se({ idempotency_key: "abc", metadata: { click_url: "https://x" } });
    const a = standardizedToAnalyticsEvent(ev);
    expect(a.idempotency_key).toBe("abc");
    expect(a.metadata?.provider).toBe("sendgrid");
    expect(a.metadata?.click_url).toBe("https://x");
    expect(a.metadata?.campaign_id).toBe("c1");
    expect(a.metadata?.organization_id).toBe("o1");
  });

  it("buildPayloadForGroup shapes AnalyticsPayload", () => {
    const p = buildPayloadForGroup({
      campaign_id: "c",
      organization_id: "o",
      events: [se()],
    });
    expect(p.campaign_id).toBe("c");
    expect(p.events).toHaveLength(1);
  });
});

describe("flushEnvelopesSync with fetch mock", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts and returns ok when response ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ events_processed: 1 }),
      })
    );
    const r = await flushEnvelopesSync(
      [{ callbackUrl: "http://127.0.0.1:9/api/webhooks/campaign-analytics/x", event: se() }],
      "secret"
    );
    expect(r.ok).toBe(true);
  });

  it("does not retry on 400", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "bad",
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await flushEnvelopesSync(
      [{ callbackUrl: "http://127.0.0.1:9/api/webhooks/campaign-analytics/x", event: se() }],
      "secret"
    );
    expect(r.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("signPayload matches HMAC hex", () => {
    expect(signPayload("{}", "k")).toHaveLength(64);
  });
});
