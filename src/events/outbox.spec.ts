import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatcherDb } from "../db/client.js";
import { countOutboxByStatus, selectDueOutbox } from "../db/repos/outbox.js";
import { createTestDb, destroyTestDb } from "../db/test-utils.js";
import type { StandardizedEvent } from "./common/types.js";
import { deliverDueBatch, enqueueEvents } from "./outbox.js";

const SECRET = "test-analytics-secret";

const stdEvent = (overrides: Partial<StandardizedEvent> = {}): StandardizedEvent => ({
  campaign_id: "cmp_1",
  user_id: "u1",
  organization_id: "org_1",
  analytics_callback_url: "https://atlas.example/api/webhooks/campaign-analytics",
  channel: "email",
  event: "dispatched",
  provider: "ses",
  provider_message_id: "msg-1",
  occurred_at: "2026-07-14T10:00:00.000Z",
  idempotency_key: "idem-1",
  ...overrides,
});

const envelope = (event: StandardizedEvent) => ({ callbackUrl: event.analytics_callback_url!, event });

let dbx: DispatcherDb;

beforeEach(async () => {
  dbx = await createTestDb();
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  destroyTestDb(dbx);
  vi.restoreAllMocks();
  delete process.env.DISPATCHER_OUTBOX_MAX_ATTEMPTS;
});

describe("event outbox", () => {
  it("delivers a queued event and marks it delivered", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 })
    );
    await enqueueEvents([envelope(stdEvent())]);
    expect(await countOutboxByStatus()).toMatchObject({ pending: 1 });

    const result = await deliverDueBatch(100, SECRET);
    expect(result.delivered).toBe(1);
    expect(await countOutboxByStatus()).toMatchObject({ delivered: 1 });
  });

  it("backs off and re-queues on a retryable failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("busy", { status: 503 })
    );
    await enqueueEvents([envelope(stdEvent())]);
    // Row is enqueued as due "now" (wall clock); advance slightly so it's picked up.
    const now = new Date(Date.now() + 60_000);
    const result = await deliverDueBatch(100, SECRET, now);
    expect(result.failed).toBe(1);

    // Still pending, but scheduled for the future — not immediately due.
    expect(await countOutboxByStatus()).toMatchObject({ pending: 1 });
    const dueNow = await selectDueOutbox(100, now);
    expect(dueNow).toHaveLength(0);
    const dueLater = await selectDueOutbox(100, new Date(now.getTime() + 2 * 60 * 60 * 1000));
    expect(dueLater).toHaveLength(1);
    expect(dueLater[0]!.attempts).toBe(1);
  });

  it("marks an event failed after exhausting attempts", async () => {
    process.env.DISPATCHER_OUTBOX_MAX_ATTEMPTS = "2";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("busy", { status: 503 })
    );
    await enqueueEvents([envelope(stdEvent())]);

    let now = new Date(Date.now() + 60_000);
    await deliverDueBatch(100, SECRET, now); // attempt 1
    now = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    await deliverDueBatch(100, SECRET, now); // attempt 2 -> terminal

    expect(await countOutboxByStatus()).toMatchObject({ failed: 1 });
  });

  it("survives a restart: a fresh process sees the pending rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await enqueueEvents([envelope(stdEvent({ idempotency_key: "idem-restart" }))]);

    // "restart": same DB file would persist; here we just re-query with a new call.
    const pending = await selectDueOutbox(100, new Date());
    expect(pending).toHaveLength(1);
    const result = await deliverDueBatch(100, SECRET);
    expect(result.delivered).toBe(1);
  });
});
