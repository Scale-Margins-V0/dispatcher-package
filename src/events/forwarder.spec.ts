import { describe, expect, it, vi, afterEach } from "vitest";

import type { StandardizedEvent } from "./common/types.js";

import {
  registerCampaignCallback,
  resetCampaignCallbackRegistryForTests,
} from "./campaign-callback-registry.js";
import {
  buildIdempotencyKey,
  buildPayloadForGroup,
  flushEnvelopesSync,
  groupEnvelopesByDestination,
  standardizedToAnalyticsEvent,
  signPayload,
  validateCallbackUrl,
} from "./forwarder.js";
import {
  resolveAnalyticsCallbackUrl,
  SCALEMARGIN_ANALYTICS_CALLBACK_URL_ENV,
} from "./resolve-analytics-callback-url.js";

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
    const k = buildIdempotencyKey(
      "sendgrid",
      "m1",
      "delivered",
      "2020-01-01T00:00:00.000Z"
    );
    expect(k).toHaveLength(32);
    expect(k).toMatch(/^[0-9a-f]+$/);
  });

  it("groupEnvelopesByDestination splits by url and campaign", () => {
    const g = groupEnvelopesByDestination([
      {
        callbackUrl: "http://a/x",
        event: se({ campaign_id: "c1", user_id: "u1" }),
      },
      {
        callbackUrl: "http://a/x",
        event: se({ campaign_id: "c1", user_id: "u2" }),
      },
      { callbackUrl: "http://b/y", event: se({ campaign_id: "c2" }) },
    ]);
    expect(g.size).toBe(2);
  });

  it("standardizedToAnalyticsEvent maps metadata", () => {
    const ev = se({
      idempotency_key: "abc",
      metadata: { click_url: "https://x" },
      analytics_callback_url: "https://cb.example/hook",
    });
    const a = standardizedToAnalyticsEvent(ev);
    expect(a.idempotency_key).toBe("abc");
    expect(a.metadata?.provider).toBe("sendgrid");
    expect(a.metadata?.click_url).toBe("https://x");
    expect(a.metadata?.campaign_id).toBe("c1");
    expect(a.metadata?.organization_id).toBe("o1");
    expect(a.metadata?.user_id).toBe("u1");
    expect(a.metadata?.channel).toBe("email");
    expect(a.metadata?.provider_message_id).toBe("mid");
    expect(a.metadata?.analytics_callback_url).toBe("https://cb.example/hook");
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
      [
        {
          callbackUrl: "http://127.0.0.1:9/api/webhooks/campaign-analytics/x",
          event: se(),
        },
      ],
      "secret"
    );
    expect(r.ok).toBeTruthy();
  });

  it("does not retry on 400", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "bad",
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await flushEnvelopesSync(
      [
        {
          callbackUrl: "http://127.0.0.1:9/api/webhooks/campaign-analytics/x",
          event: se(),
        },
      ],
      "secret"
    );
    expect(r.ok).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("signPayload matches HMAC hex", () => {
    expect(signPayload("{}", "k")).toHaveLength(64);
  });
});

describe("validateCallbackUrl", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("allows expected analytics callback path in test", () => {
    process.env.NODE_ENV = "test";
    expect(
      validateCallbackUrl(
        "http://127.0.0.1:3000/api/webhooks/campaign-analytics/capture"
      )
    ).toBeTruthy();
  });

  it("allows unexpected path outside production (with warning)", () => {
    process.env.NODE_ENV = "test";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(validateCallbackUrl("http://127.0.0.1:3000/not-analytics")).toBeTruthy();
      expect(warn).toHaveBeenCalledWith(
        "[EventsForwarder] Unexpected callback path: /not-analytics. Proceeding anyway."
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects unexpected path in production", () => {
    process.env.NODE_ENV = "production";
    expect(
      validateCallbackUrl("https://callbacks.example.com/not-analytics")
    ).toBeFalsy();
  });

  it("rejects private host callback in production", () => {
    process.env.NODE_ENV = "production";
    expect(
      validateCallbackUrl(
        "https://127.0.0.1/api/webhooks/campaign-analytics/capture"
      )
    ).toBeFalsy();
  });
});

describe("resolveAnalyticsCallbackUrl", () => {
  it("prefers correlation callback over registry and env", () => {
    resetCampaignCallbackRegistryForTests();
    vi.stubEnv(
      SCALEMARGIN_ANALYTICS_CALLBACK_URL_ENV,
      "http://127.0.0.1:1/env/api/webhooks/campaign-analytics/x"
    );
    registerCampaignCallback("c1", "o1", "http://127.0.0.1:1/reg");
    try {
      expect(
        resolveAnalyticsCallbackUrl({
          campaignId: "c1",
          correlationCallbackUrl: "  http://127.0.0.1:1/corr  ",
        })
      ).toBe("http://127.0.0.1:1/corr");
    } finally {
      resetCampaignCallbackRegistryForTests();
      vi.unstubAllEnvs();
    }
  });

  it("uses registry when correlation has no callback", () => {
    resetCampaignCallbackRegistryForTests();
    try {
      registerCampaignCallback(
        "c1",
        "o1",
        "http://127.0.0.1:2/api/webhooks/campaign-analytics/r"
      );
      expect(resolveAnalyticsCallbackUrl({ campaignId: "c1" })).toBe(
        "http://127.0.0.1:2/api/webhooks/campaign-analytics/r"
      );
    } finally {
      resetCampaignCallbackRegistryForTests();
    }
  });

  it("uses env when registry misses", () => {
    resetCampaignCallbackRegistryForTests();
    vi.stubEnv(
      SCALEMARGIN_ANALYTICS_CALLBACK_URL_ENV,
      "http://127.0.0.1:3/api/webhooks/campaign-analytics/fallback"
    );
    try {
      expect(resolveAnalyticsCallbackUrl({ campaignId: "unknown" })).toBe(
        "http://127.0.0.1:3/api/webhooks/campaign-analytics/fallback"
      );
    } finally {
      resetCampaignCallbackRegistryForTests();
      vi.unstubAllEnvs();
    }
  });

  it("returns undefined when env is set but fails validateCallbackUrl (production + private host)", () => {
    resetCampaignCallbackRegistryForTests();
    vi.stubEnv(
      SCALEMARGIN_ANALYTICS_CALLBACK_URL_ENV,
      "http://127.0.0.1:3/api/webhooks/campaign-analytics/fallback"
    );
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(
        resolveAnalyticsCallbackUrl({ campaignId: "unknown" })
      ).toBeUndefined();
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      resetCampaignCallbackRegistryForTests();
      vi.unstubAllEnvs();
    }
  });

  it("registry wins over env when both present", () => {
    resetCampaignCallbackRegistryForTests();
    vi.stubEnv(
      SCALEMARGIN_ANALYTICS_CALLBACK_URL_ENV,
      "http://127.0.0.1:8/api/webhooks/campaign-analytics/env"
    );
    try {
      registerCampaignCallback(
        "c1",
        "o1",
        "http://127.0.0.1:9/api/webhooks/campaign-analytics/reg"
      );
      expect(resolveAnalyticsCallbackUrl({ campaignId: "c1" })).toContain(
        ":9/"
      );
    } finally {
      resetCampaignCallbackRegistryForTests();
      vi.unstubAllEnvs();
    }
  });
});
