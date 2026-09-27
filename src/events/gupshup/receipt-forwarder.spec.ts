/**
 * WhatsApp receipts carry no campaign, so they cannot use a per-campaign
 * analytics URL. They go to the configured analytics_callback_url, else to the
 * URL ScaleMargin sent on the latest dispatch — never to a built-in host (a
 * hard-coded dev URL once caught a production client's receipts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatcherDb } from "../../db/client.js";
import { upsertCampaignCallback } from "../../db/repos/campaign-callbacks.js";
import { createTestDb, destroyTestDb } from "../../db/test-utils.js";
import {
  latestAnalyticsCallbackUrl,
  registerCampaignCallback,
  resetCampaignCallbackRegistryForTests,
  warmCampaignCallbackCache,
} from "../campaign-callback-registry.js";
import { forwardFreshchatReceipts } from "../freshchat/receipt-forwarder.js";
import { forwardGupshupReceipts, resolveWhatsAppReceiptsUrl } from "./receipt-forwarder.js";

const PROD = "https://app.scalemargins.tech/api/webhooks/campaign-analytics";
const STG = "https://stg.scalemargins.tech/api/webhooks/campaign-analytics";
const receipt = { external_id: "ext-1", event: "delivered", occurred_at: "2026-09-25T10:00:00Z" } as const;

const saved = process.env.SCALEMARGIN_ANALYTICS_CALLBACK_URL;
beforeEach(() => {
  delete process.env.SCALEMARGIN_ANALYTICS_CALLBACK_URL;
  resetCampaignCallbackRegistryForTests();
});
afterEach(() => {
  if (saved === undefined) delete process.env.SCALEMARGIN_ANALYTICS_CALLBACK_URL;
  else process.env.SCALEMARGIN_ANALYTICS_CALLBACK_URL = saved;
  resetCampaignCallbackRegistryForTests();
  vi.restoreAllMocks();
});

describe("resolveWhatsAppReceiptsUrl", () => {
  it("has no built-in default — unknown means undefined, never a dev host", () => {
    expect(resolveWhatsAppReceiptsUrl()).toBeUndefined();
  });

  it("uses the URL from the most recent dispatch", () => {
    registerCampaignCallback("c1", "org", STG);
    registerCampaignCallback("c2", "org", PROD);
    expect(resolveWhatsAppReceiptsUrl()).toBe(PROD);
  });

  it("prefers the configured analytics_callback_url over what dispatches sent", () => {
    process.env.SCALEMARGIN_ANALYTICS_CALLBACK_URL = PROD;
    registerCampaignCallback("c1", "org", STG);
    expect(resolveWhatsAppReceiptsUrl()).toBe(PROD);
  });

  it("ignores an unusable configured value and falls back to the dispatch URL", () => {
    process.env.SCALEMARGIN_ANALYTICS_CALLBACK_URL = "not a url";
    registerCampaignCallback("c1", "org", PROD);
    expect(resolveWhatsAppReceiptsUrl()).toBe(PROD);
  });
});

describe("after a restart", () => {
  let dbx: DispatcherDb;
  beforeEach(async () => {
    dbx = await createTestDb();
  });
  afterEach(() => destroyTestDb(dbx));

  it("the boot warm-load restores the most recently used URL", async () => {
    await upsertCampaignCallback("old", "org", STG);
    await new Promise((r) => setTimeout(r, 5));
    await upsertCampaignCallback("new", "org", PROD);
    resetCampaignCallbackRegistryForTests(); // the process restarted
    expect(latestAnalyticsCallbackUrl()).toBeUndefined();
    await warmCampaignCallbackCache();
    expect(resolveWhatsAppReceiptsUrl()).toBe(PROD);
  });
});

describe("forwarding with no URL known", () => {
  it("drops receipts with a hint, and contacts nobody", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const g = await forwardGupshupReceipts([receipt as never], "secret");
    const f = await forwardFreshchatReceipts([receipt as never], "secret");
    expect(g).toEqual({ success: false, error: "no receipts URL configured" });
    expect(f).toEqual({ success: false, error: "no receipts URL configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts to the dispatch-learned URL, signed", async () => {
    registerCampaignCallback("c1", "org", PROD);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const res = await forwardGupshupReceipts([receipt as never], "secret");
    expect(res.success).toBe(true);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(PROD);
    const headers = fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["X-ScaleMargin-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers["X-ScaleMargin-Timestamp"]).toBeTruthy();
  });
});
