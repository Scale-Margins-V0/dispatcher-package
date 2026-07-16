import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherDb } from "./client.js";
import { queryDb, tableFor } from "./dialect-helpers.js";
import { insertLogs, queryLogs } from "./repos/logs.js";
import { runRetentionSweep } from "./retention.js";
import { createTestDb, destroyTestDb } from "./test-utils.js";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-07-14T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);

let dbx: DispatcherDb;

beforeEach(async () => {
  dbx = await createTestDb();
});

afterEach(() => {
  destroyTestDb(dbx);
  delete process.env.DISPATCHER_LOG_RETENTION_DAYS;
  delete process.env.DISPATCHER_LOG_MAX_ROWS;
  delete process.env.DISPATCHER_CAMPAIGN_EVENTS_RETENTION_DAYS;
  delete process.env.DISPATCHER_CAMPAIGN_EVENTS_MAX_ROWS;
});

const logRow = (ts: Date, id: string) => ({
  id,
  ts,
  level: "info" as const,
  request_id: null,
  campaign_id: null,
  component: null,
  message: `log ${id}`,
  stack: null,
  context: null,
});

describe("runRetentionSweep", () => {
  it("deletes app_logs older than the retention window", async () => {
    await insertLogs([logRow(daysAgo(20), "old"), logRow(daysAgo(1), "fresh")]);
    await runRetentionSweep(now);
    const page = await queryLogs({ limit: 10 });
    expect(page.logs.map((l) => l.id)).toEqual(["fresh"]);
  });

  it("enforces the app_logs row cap, keeping the newest rows", async () => {
    process.env.DISPATCHER_LOG_MAX_ROWS = "3";
    const rows = Array.from({ length: 6 }, (_, i) =>
      logRow(new Date(now.getTime() - i * 60_000), `row-${i}`)
    );
    await insertLogs(rows);
    await runRetentionSweep(now);
    const page = await queryLogs({ limit: 10 });
    expect(page.logs.map((l) => l.id)).toEqual(["row-0", "row-1", "row-2"]);
  });

  it("deletes campaign_events past the window and enforces the row cap", async () => {
    const { insertCampaignEvents, listCampaignEvents } = await import(
      "./repos/campaign-events.js"
    );
    process.env.DISPATCHER_CAMPAIGN_EVENTS_MAX_ROWS = "2";
    const mkEvent = (id: string, occurred: Date) => ({
      id,
      campaign_id: "c1",
      organization_id: "o1",
      user_id: `u-${id}`,
      channel: "email",
      event: "dispatched",
      provider: "ses",
      provider_message_id: null,
      occurred_at: occurred,
      received_at: occurred,
      metadata: null,
      dedupe_key: id,
    });
    await insertCampaignEvents([
      mkEvent("ancient", daysAgo(100)), // beyond 90d window
      mkEvent("old", daysAgo(5)),
      mkEvent("mid", daysAgo(2)),
      mkEvent("fresh", daysAgo(1)),
    ]);
    await runRetentionSweep(now);
    const page = await listCampaignEvents({ campaign_id: "c1", limit: 10 });
    expect(page.events.map((e) => e.id)).toEqual(["fresh", "mid"]);
  });

  it("prunes delivered/failed outbox rows and stale callbacks by their windows", async () => {
    const q = queryDb(dbx);
    const outbox = tableFor(dbx, "eventOutbox");
    const mkOutbox = (id: string, status: string, created: Date) => ({
      id,
      callback_url: "https://cb.example/x",
      campaign_id: "c1",
      organization_id: "o1",
      event: { t: 1 },
      idempotency_key: id,
      status,
      attempts: 0,
      next_attempt_at: created,
      last_error: null,
      created_at: created,
      delivered_at: status === "delivered" ? created : null,
    });
    await q.insert(outbox).values([
      mkOutbox("delivered-old", "delivered", daysAgo(8)),
      mkOutbox("delivered-new", "delivered", daysAgo(2)),
      mkOutbox("failed-old", "failed", daysAgo(40)),
      mkOutbox("pending-old", "pending", daysAgo(40)),
    ]);

    const callbacks = tableFor(dbx, "campaignCallbacks");
    await q.insert(callbacks).values([
      {
        campaign_id: "stale",
        organization_id: "o1",
        analytics_callback_url: "https://cb.example/a",
        created_at: daysAgo(60),
        last_used_at: daysAgo(45),
      },
      {
        campaign_id: "active",
        organization_id: "o1",
        analytics_callback_url: "https://cb.example/b",
        created_at: daysAgo(60),
        last_used_at: daysAgo(1),
      },
    ]);

    await runRetentionSweep(now);

    const outboxLeft: Array<{ id: string }> = await q.select({ id: outbox.id }).from(outbox);
    expect(outboxLeft.map((r) => r.id).sort()).toEqual(["delivered-new", "pending-old"]);

    const callbacksLeft: Array<{ campaign_id: string }> = await q
      .select({ campaign_id: callbacks.campaign_id })
      .from(callbacks);
    expect(callbacksLeft.map((r) => r.campaign_id)).toEqual(["active"]);
  });
});
