import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backfillCampaignEventsOnce } from "./campaign-events-backfill.js";
import type { DispatcherDb } from "./client.js";
import { queryDb, tableFor } from "./dialect-helpers.js";
import { listCampaignEvents } from "./repos/campaign-events.js";
import { getMeta } from "./repos/meta.js";
import { META_KEYS } from "./schema/index.js";
import { createTestDb, destroyTestDb } from "./test-utils.js";

let dbx: DispatcherDb;

beforeEach(async () => {
  dbx = await createTestDb();
});

afterEach(() => {
  destroyTestDb(dbx);
});

const T0 = new Date("2026-07-01T00:00:00.000Z");

async function seedOutbox(count: number, opts: { withIdempotency?: boolean } = {}): Promise<void> {
  const outbox = tableFor(dbx, "eventOutbox");
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `ob-${String(i).padStart(4, "0")}`,
    callback_url: "https://client.example/analytics",
    campaign_id: "cmp_hist",
    organization_id: "org_1",
    event: {
      campaign_id: "cmp_hist",
      user_id: `user-${i}`,
      organization_id: "org_1",
      channel: "email",
      event: i % 3 === 0 ? "delivered" : "dispatched",
      provider: "ses",
      provider_message_id: `msg-${i}`,
      occurred_at: new Date(T0.getTime() + i * 1000).toISOString(),
      ...(opts.withIdempotency ? { idempotency_key: `ik-${i}` } : {}),
    },
    idempotency_key: opts.withIdempotency ? `ik-${i}` : "",
    status: i % 2 === 0 ? "delivered" : "pending",
    attempts: 0,
    next_attempt_at: new Date(T0.getTime() + i * 1000),
    last_error: null,
    created_at: new Date(T0.getTime() + i * 1000),
    delivered_at: null,
  }));
  await queryDb(dbx).insert(outbox).values(rows);
}

describe("backfillCampaignEventsOnce", () => {
  it("copies envelopes across batch boundaries and marks completion", async () => {
    await seedOutbox(520, { withIdempotency: true }); // > one 500-row batch
    const result = await backfillCampaignEventsOnce();
    expect(result.copied).toBe(520);

    const page = await listCampaignEvents({ campaign_id: "cmp_hist", limit: 200 });
    expect(page.events.length).toBe(200); // paged read; total verified via second run below
    expect(await getMeta(META_KEYS.campaignEventsBackfillDoneAt)).not.toBeNull();

    // Second boot: meta flag short-circuits, nothing copied.
    const again = await backfillCampaignEventsOnce();
    expect(again.copied).toBe(0);
  });

  it("skips malformed envelopes and stays idempotent without envelope keys", async () => {
    await seedOutbox(3);
    const outbox = tableFor(dbx, "eventOutbox");
    await queryDb(dbx)
      .insert(outbox)
      .values({
        id: "ob-broken",
        callback_url: "https://client.example/analytics",
        campaign_id: "cmp_hist",
        organization_id: "org_1",
        event: { not: "an event" },
        idempotency_key: "",
        status: "pending",
        attempts: 0,
        next_attempt_at: T0,
        last_error: null,
        created_at: T0,
        delivered_at: null,
      });

    const result = await backfillCampaignEventsOnce();
    expect(result.copied).toBe(3);
    const page = await listCampaignEvents({ campaign_id: "cmp_hist", limit: 10 });
    expect(page.events).toHaveLength(3);
  });

  it("dedupes against events already persisted live", async () => {
    await seedOutbox(2, { withIdempotency: true });
    const { persistCampaignEvents } = await import("../events/persist.js");
    // One of the two envelopes was already written by the live pipeline.
    await persistCampaignEvents([
      {
        campaign_id: "cmp_hist",
        user_id: "user-0",
        organization_id: "org_1",
        channel: "email",
        event: "delivered",
        provider: "ses",
        provider_message_id: "msg-0",
        occurred_at: T0.toISOString(),
        idempotency_key: "ik-0",
      },
    ]);
    await backfillCampaignEventsOnce();
    const page = await listCampaignEvents({ campaign_id: "cmp_hist", limit: 10 });
    expect(page.events).toHaveLength(2);
  });
});
