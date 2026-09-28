/**
 * The Freshchat status poller, end to end against a real state database:
 * queued sends → status API → forward-only-progress → receipts to ScaleMargin
 * → saved poll state. Freshchat and ScaleMargin are both fetch mocks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatcherDb } from "../../db/client.js";
import { queryDb, tableFor } from "../../db/dialect-helpers.js";
import { insertProviderMessageIds } from "../../db/repos/provider-message-ids.js";
import { createTestDb, destroyTestDb } from "../../db/test-utils.js";
import { MessageIdRecorder } from "../../dispatch/message-id-recorder.js";
import { envYamlSchema, resetEnvYamlForTests, setEnvYamlForTests } from "../../env-yaml.js";
import { registry } from "../../providers/senders.js";
import { resetCampaignCallbackRegistryForTests } from "../campaign-callback-registry.js";
import {
  freshchatStatusUrl,
  initialPollAt,
  isFinalEvent,
  nextPollDelayMs,
  parseStatusResponse,
  impliedSteps,
  pollFreshchatStatusesOnce,
  reconcileWebhookReceipts,
  recordReportedStatuses,
  resetFreshchatStatusPollerForTests,
  statusRank,
  withImpliedSteps,
} from "./status-poller.js";

const SEND_URL = "https://acme-123.freshchat.com/v2/outbound-messages/whatsapp";
const ANALYTICS = "https://app.scalemargins.tech/api/webhooks/campaign-analytics";
const MIN = 60_000;

const fcSender = (id: string, freshchat: Record<string, unknown> = {}) => ({
  id,
  channel: "whatsapp",
  provider: "freshchat",
  freshchat: { api_key: `key-${id}`, source: "918306107771", template_api_url: SEND_URL, status_poller: true, ...freshchat },
});

/** The shape Freshchat returns — trimmed from a real response. */
const statusBody = (requestId: string, status: string, extra: Record<string, unknown> = {}) => ({
  outbound_messages: [
    { message_id: `msg-${requestId}`, provider: "whatsapp", request_id: requestId, status, created_on: 1788269967876, ...extra },
  ],
});

let dbx: DispatcherDb;
let statuses: Record<string, { status?: number; body?: unknown; retryAfter?: string }>;
let analyticsStatus: number;
let fetchMock: ReturnType<typeof vi.fn>;

async function queue(requestId: string, opts: { sender?: string; sentAgoMs?: number; dueAgoMs?: number } = {}) {
  const now = Date.now();
  await insertProviderMessageIds([
    {
      id: crypto.randomUUID(),
      provider: "freshchat",
      provider_message_id: requestId,
      user_id: `user-${requestId}`,
      sent_at: new Date(now - (opts.sentAgoMs ?? MIN)),
      sender_id: opts.sender ?? "fc",
      next_poll_at: new Date(now - (opts.dueAgoMs ?? 1000)),
    },
  ]);
}

async function row(requestId: string) {
  const t = tableFor(dbx, "providerMessageIds");
  const rows = await queryDb(dbx).select().from(t);
  return (rows as Array<Record<string, unknown>>).find((r) => r.provider_message_id === requestId)!;
}

const analyticsPosts = () =>
  fetchMock.mock.calls.filter((c) => String(c[0]) === ANALYTICS).map((c) => JSON.parse(String((c[1] as RequestInit).body)));
const statusCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("/v2/outbound-messages?"));

function useSenders(senders: unknown[]) {
  setEnvYamlForTests(envYamlSchema.parse({ version: 1, senders }) as never);
  registry.resetForTests();
}

const savedEnv = { ...process.env };
beforeEach(async () => {
  dbx = await createTestDb();
  process.env.SCALEMARGIN_ANALYTICS_CALLBACK_URL = ANALYTICS;
  process.env.SCALEMARGIN_ANALYTICS_SECRET = "analytics-secret";
  process.env.DISPATCHER_MESSAGE_ID_TTL = "5d";
  delete process.env.DISPATCHER_FRESHCHAT_STATUS_POLL_TTL;
  resetEnvYamlForTests();
  resetCampaignCallbackRegistryForTests();
  resetFreshchatStatusPollerForTests();
  useSenders([fcSender("fc")]);
  statuses = {};
  analyticsStatus = 200;
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === ANALYTICS) return new Response("{}", { status: analyticsStatus });
    const requestId = new URL(url).searchParams.get("request_id")!;
    const s = statuses[requestId] ?? { status: 404 };
    return new Response(s.body === undefined ? "" : JSON.stringify(s.body), {
      status: s.status ?? 200,
      headers: s.retryAfter ? { "retry-after": s.retryAfter } : {},
    });
  });
  // Forwarding uses the global fetch — stub it so nothing ever leaves the test.
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  destroyTestDb(dbx);
  process.env = { ...savedEnv };
  resetEnvYamlForTests();
  registry.resetForTests();
  resetFreshchatStatusPollerForTests();
});

const tick = () => pollFreshchatStatusesOnce(new Date(), fetchMock as unknown as typeof fetch);

describe("pure helpers", () => {
  it("derives the status endpoint from the send endpoint", () => {
    expect(freshchatStatusUrl(SEND_URL, "abc-1")).toBe(
      "https://acme-123.freshchat.com/v2/outbound-messages?request_id=abc-1"
    );
    expect(freshchatStatusUrl("https://x.freshchat.com/custom/send", "r")).toBe(
      "https://x.freshchat.com/v2/outbound-messages?request_id=r"
    );
  });

  it("reads a real status response", () => {
    expect(parseStatusResponse(statusBody("2ae6", "READ"), "2ae6")).toEqual({
      kind: "status",
      status: "READ",
      messageId: "msg-2ae6",
    });
    expect(parseStatusResponse({ outbound_messages: [] }, "x")).toEqual({ kind: "unknown" });
    expect(parseStatusResponse(statusBody("r", "FAILED", { failure_reason: "blocked", failure_code: 131026 }), "r")).toMatchObject({
      cause: "blocked",
      errorCode: "131026",
    });
  });

  it("ranks progress and knows what is final", () => {
    expect(statusRank(null)).toBe(statusRank("dispatched"));
    expect(statusRank("read")).toBeGreaterThan(statusRank("delivered"));
    expect(isFinalEvent("read")).toBe(true);
    expect(isFinalEvent("delivered")).toBe(false);
  });

  it("backs off as a message ages", () => {
    expect(nextPollDelayMs(10_000, MIN)).toBe(10_000);
    expect(nextPollDelayMs(10_000, 30 * MIN)).toBe(60_000);
    expect(nextPollDelayMs(10_000, 3 * 60 * MIN)).toBe(300_000);
  });

  it("queues only sends of a sender with the poller on", () => {
    expect(initialPollAt(fcSender("a") as never)).toBeInstanceOf(Date);
    expect(initialPollAt(fcSender("a", { status_poller: false }) as never)).toBeNull();
    expect(initialPollAt({ id: "g", provider: "gupshup", channel: "whatsapp" } as never)).toBeNull();
  });
});

describe("config", () => {
  it("defaults off, and rejects an interval under 5s or a stray key", () => {
    const ok = envYamlSchema.parse({ version: 1, senders: [fcSender("fc", { status_poller: undefined })] });
    expect(ok.senders[0]!.freshchat?.status_poller).toBeUndefined();
    expect(envYamlSchema.safeParse({ version: 1, senders: [fcSender("fc", { status_poll_interval_seconds: 2 })] }).success).toBe(false);
    expect(envYamlSchema.safeParse({ version: 1, senders: [fcSender("fc", { enable_poller: true })] }).success).toBe(false);
  });
});

describe("recording a send", () => {
  it("stores the sender and the first poll time", async () => {
    const recorder = new MessageIdRecorder();
    const pollAt = new Date(Date.now() + 10_000);
    recorder.add("freshchat", "req-1", "u1", { senderId: "fc", pollAt });
    recorder.flush();
    await vi.waitFor(async () => expect(await row("req-1")).toBeDefined());
    const r = await row("req-1");
    expect(r.sender_id).toBe("fc");
    expect(new Date(r.next_poll_at as Date).getTime()).toBe(pollAt.getTime());
  });
});

describe("a poll tick", () => {
  it("forwards a status that moved forward, and keeps polling", async () => {
    await queue("r1");
    statuses.r1 = { body: statusBody("r1", "DELIVERED") };
    const res = await tick();
    expect(res).toMatchObject({ polled: 1, forwarded: 1 });
    expect(analyticsPosts()).toEqual([
      { channel: "whatsapp", receipts: [expect.objectContaining({ external_id: "r1", event: "delivered", provider: "freshchat" })] },
    ]);
    const r = await row("r1");
    expect(r).toMatchObject({ status: "DELIVERED", status_event: "delivered", provider_ref: "msg-r1", poll_attempts: 1 });
    expect(r.next_poll_at).not.toBeNull();
  });

  it("stops polling at a final status", async () => {
    await queue("r1");
    statuses.r1 = { body: statusBody("r1", "READ") };
    await tick();
    expect((await row("r1")).next_poll_at).toBeNull();
  });

  it("does not forward SENT/ACCEPTED — the dispatch already reported it", async () => {
    await queue("r1");
    statuses.r1 = { body: statusBody("r1", "SENT") };
    const res = await tick();
    expect(res).toMatchObject({ forwarded: 0, unchanged: 1 });
    expect(analyticsPosts()).toEqual([]);
  });

  it("never forwards the same change twice", async () => {
    await queue("r1");
    statuses.r1 = { body: statusBody("r1", "DELIVERED") };
    await tick();
    await queue("r2"); // keep the tick busy; r1 is not due again yet
    await tick();
    expect(analyticsPosts().flatMap((p) => p.receipts).filter((r: { external_id: string }) => r.external_id === "r1")).toHaveLength(1);
  });

  it("carries the failure reason on FAILED", async () => {
    await queue("r1");
    statuses.r1 = { body: statusBody("r1", "FAILED", { failure_reason: "user blocked", failure_code: "131026" }) };
    await tick();
    expect(analyticsPosts()[0].receipts[0]).toMatchObject({ event: "bounced", cause: "user blocked", error_code: "131026" });
  });

  it("if ScaleMargin refuses the receipt, the change is retried on the next poll", async () => {
    await queue("r1");
    statuses.r1 = { body: statusBody("r1", "READ") };
    analyticsStatus = 400;
    await tick();
    let r = await row("r1");
    expect(r.status_event).toBeNull(); // not recorded as reported
    expect(String(r.poll_error)).toContain("forward failed");
    expect(r.next_poll_at).not.toBeNull();

    analyticsStatus = 200;
    await queryDb(dbx).update(tableFor(dbx, "providerMessageIds")).set({ next_poll_at: new Date(Date.now() - 1000) });
    await tick();
    r = await row("r1");
    expect(r.status_event).toBe("read");
    expect(r.next_poll_at).toBeNull();
  });

  it("a status Freshchat does not know yet is simply asked again later", async () => {
    await queue("r1"); // 404
    const res = await tick();
    expect(res).toMatchObject({ polled: 1, forwarded: 0, errors: 0 });
    expect((await row("r1")).next_poll_at).not.toBeNull();
  });

  it("a 429 pauses that sender — no more calls this tick or until Retry-After", async () => {
    await queue("r1");
    await queue("r2");
    statuses.r1 = { status: 429, retryAfter: "120" };
    statuses.r2 = { status: 429, retryAfter: "120" };
    await tick();
    const before = statusCalls().length;
    await tick();
    expect(statusCalls().length).toBe(before); // paused: the second tick asks nothing
    expect(new Date((await row("r1")).next_poll_at as Date).getTime()).toBeGreaterThan(Date.now() + 100_000);
  });

  it("a rejected API key pauses the sender and is reported as an error", async () => {
    await queue("r1");
    statuses.r1 = { status: 401 };
    const res = await tick();
    expect(res.errors).toBe(1);
    expect((await row("r1")).poll_error).toBe("status API 401");
  });

  it("stops at freshchat_status_poll_ttl", async () => {
    process.env.DISPATCHER_FRESHCHAT_STATUS_POLL_TTL = "1d";
    await queue("old", { sentAgoMs: 2 * 24 * 60 * MIN });
    statuses.old = { body: statusBody("old", "READ") };
    const res = await tick();
    expect(res.polled).toBe(0);
    const r = await row("old");
    expect(r.next_poll_at).toBeNull();
    expect(r.poll_error).toBe("freshchat_status_poll_ttl reached");
  });

  it("skips senders with the poller off", async () => {
    useSenders([fcSender("fc", { status_poller: false })]);
    await queue("r1");
    statuses.r1 = { body: statusBody("r1", "READ") };
    expect((await tick()).polled).toBe(0);
    expect(statusCalls()).toHaveLength(0);
  });

  it("uses each message's own sender — key and host", async () => {
    useSenders([fcSender("a"), fcSender("b", { template_api_url: "https://other-9.freshchat.com/v2/outbound-messages/whatsapp" })]);
    await queue("ra", { sender: "a" });
    await queue("rb", { sender: "b" });
    await tick();
    const calls = statusCalls().map((c) => [new URL(String(c[0])).host, (c[1] as RequestInit).headers as Record<string, string>]);
    expect(calls).toEqual(
      expect.arrayContaining([
        ["acme-123.freshchat.com", expect.objectContaining({ Authorization: "Bearer key-a" })],
        ["other-9.freshchat.com", expect.objectContaining({ Authorization: "Bearer key-b" })],
      ])
    );
  });
});

describe("webhook and poller together", () => {
  it("a status the webhook already reported is not forwarded again, and a final one ends polling", async () => {
    await queue("r1");
    await recordReportedStatuses([{ external_id: "r1", event: "read", occurred_at: new Date().toISOString(), provider: "freshchat" }]);
    const r = await row("r1");
    expect(r.status_event).toBe("read");
    expect(r.next_poll_at).toBeNull();
    statuses.r1 = { body: statusBody("r1", "READ") };
    expect((await tick()).polled).toBe(0);
    expect(analyticsPosts()).toEqual([]);
  });

  it("a webhook status never moves a message backwards", async () => {
    await queue("r1");
    await recordReportedStatuses([{ external_id: "r1", event: "read", occurred_at: "", provider: "freshchat" }]);
    await recordReportedStatuses([{ external_id: "r1", event: "delivered", occurred_at: "", provider: "freshchat" }]);
    expect((await row("r1")).status_event).toBe("read");
  });
});

describe("steps a status must have passed", () => {
  it("fills in only the steps skipped on the ladder", () => {
    expect(impliedSteps(null, "delivered")).toEqual([]);
    expect(impliedSteps(null, "read")).toEqual(["delivered"]);
    expect(impliedSteps("dispatched", "clicked")).toEqual(["delivered", "read"]);
    expect(impliedSteps("delivered", "read")).toEqual([]);
    expect(impliedSteps("delivered", "clicked")).toEqual(["read"]);
    // A failure implies nothing; nothing moves backwards; bounced is off the ladder.
    expect(impliedSteps(null, "bounced")).toEqual([]);
    expect(impliedSteps("read", "delivered")).toEqual([]);
    expect(impliedSteps("bounced", "read")).toEqual([]);
  });

  it("orders implied receipts just before the real one, carrying its stamp", () => {
    const at = "2026-09-28T10:00:00.000Z";
    const out = withImpliedSteps({ external_id: "r", event: "clicked", occurred_at: at, sign: "s", provider: "freshchat" }, null);
    expect(out.map((r) => [r.event, r.occurred_at, r.sign])).toEqual([
      ["delivered", "2026-09-28T09:59:59.998Z", "s"],
      ["read", "2026-09-28T09:59:59.999Z", "s"],
      ["clicked", at, "s"],
    ]);
  });
});

describe("a status that jumped between two polls", () => {
  const events = () => analyticsPosts().flatMap((p) => p.receipts.map((r: { event: string }) => r.event));

  it("READ seen first also reports delivered, in order", async () => {
    await queue("r1");
    statuses.r1 = { body: statusBody("r1", "READ") };
    expect(await tick()).toMatchObject({ forwarded: 1 });
    expect(events()).toEqual(["delivered", "read"]);
    expect((await row("r1")).status_event).toBe("read");
  });

  it("CLICKED seen first reports delivered and read too", async () => {
    await queue("r1");
    statuses.r1 = { body: statusBody("r1", "CLICKED") };
    await tick();
    expect(events()).toEqual(["delivered", "read", "clicked"]);
  });

  it("READ after DELIVERED was already reported adds nothing", async () => {
    await queue("r1");
    statuses.r1 = { body: statusBody("r1", "DELIVERED") };
    await tick();
    statuses.r1 = { body: statusBody("r1", "READ") };
    await pollFreshchatStatusesOnce(new Date(Date.now() + 60_000), fetchMock as unknown as typeof fetch);
    expect(events()).toEqual(["delivered", "read"]);
  });

  it("FAILED reports only the failure", async () => {
    await queue("r1");
    statuses.r1 = { body: statusBody("r1", "FAILED") };
    await tick();
    expect(events()).toEqual(["bounced"]);
  });
});

describe("webhook receipts reconciled with what was reported", () => {
  const rc = (external_id: string, event: string) =>
    ({ external_id, event, occurred_at: "2026-09-28T10:00:00.000Z", provider: "freshchat" }) as never;
  const ev = (list: Array<{ external_id: string; event: string }>) => list.map((r) => `${r.external_id}:${r.event}`);

  it("READ with nothing reported yet also sends delivered", async () => {
    await queue("r1");
    expect(ev(await reconcileWebhookReceipts([rc("r1", "read")]))).toEqual(["r1:delivered", "r1:read"]);
  });

  it("drops a step the poller already reported (no double counting)", async () => {
    await queue("r1");
    await recordReportedStatuses([rc("r1", "read")]);
    expect(await reconcileWebhookReceipts([rc("r1", "delivered"), rc("r1", "read")])).toEqual([]);
  });

  it("replays one message's out-of-order batch in ladder order, without duplicates", async () => {
    await queue("r1");
    expect(ev(await reconcileWebhookReceipts([rc("r1", "read"), rc("r1", "delivered")]))).toEqual(["r1:delivered", "r1:read"]);
  });

  it("forwards a later step after an earlier one was reported", async () => {
    await queue("r1");
    await recordReportedStatuses([rc("r1", "delivered")]);
    expect(ev(await reconcileWebhookReceipts([rc("r1", "read")]))).toEqual(["r1:read"]);
  });

  it("passes through a message it has no record of, and never drops dispatched or failures", async () => {
    await queue("r1");
    await recordReportedStatuses([rc("r1", "delivered")]);
    // Order only matters within one message.
    const out = ev(await reconcileWebhookReceipts([rc("unknown", "read"), rc("r1", "dispatched"), rc("r1", "bounced")]));
    expect(out.sort()).toEqual(["r1:bounced", "r1:dispatched", "unknown:read"]);
  });
});
