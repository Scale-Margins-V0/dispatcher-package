import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherDb } from "../db/client.js";
import { listCampaignEvents } from "../db/repos/campaign-events.js";
import { createTestDb, destroyTestDb } from "../db/test-utils.js";
import type { StandardizedEvent } from "./common/types.js";
import {
  campaignEventRowFromStandardized,
  computeDedupeKey,
  persistCampaignEvents,
} from "./persist.js";

let dbx: DispatcherDb;

beforeEach(async () => {
  dbx = await createTestDb();
});

afterEach(() => {
  destroyTestDb(dbx);
});

const std = (partial: Partial<StandardizedEvent> = {}): StandardizedEvent => ({
  campaign_id: "cmp_1",
  user_id: "user_1",
  organization_id: "org_1",
  channel: "email",
  event: "delivered",
  provider: "ses",
  provider_message_id: "msg-1",
  occurred_at: "2026-07-10T10:00:00.000Z",
  ...partial,
});

describe("computeDedupeKey", () => {
  it("prefers the envelope idempotency key", () => {
    expect(computeDedupeKey(std({ idempotency_key: "ik-1" }))).toBe("ik-1");
  });

  it("falls back to a deterministic per-user hash", () => {
    const a = computeDedupeKey(std());
    expect(a).toBe(computeDedupeKey(std()));
    expect(a).toHaveLength(32);
    // Same message, different user (e.g. failure events sharing "unknown"
    // provider_message_id) must NOT collide.
    expect(computeDedupeKey(std({ user_id: "user_2" }))).not.toBe(a);
  });

  it("rejects oversized envelope keys in favor of the hash", () => {
    const key = computeDedupeKey(std({ idempotency_key: "x".repeat(65) }));
    expect(key).toHaveLength(32);
  });
});

describe("campaignEventRowFromStandardized", () => {
  it("maps fields, truncates long ids, and falls back on invalid dates", () => {
    const received = new Date("2026-07-11T00:00:00.000Z");
    const row = campaignEventRowFromStandardized(
      std({
        provider_message_id: "m".repeat(300),
        occurred_at: "not-a-date",
        metadata: { bounce_type: "hard" },
      }),
      received,
      { program_id: "cmp_1", program_kind: "campaign", step_id: null }
    );
    expect(row.provider_message_id).toHaveLength(191);
    expect(row.occurred_at).toEqual(received);
    expect(row.received_at).toEqual(received);
    expect(row.metadata).toEqual({ bounce_type: "hard" });
  });
});

describe("persistCampaignEvents", () => {
  it("writes rows and dedupes replays", async () => {
    await persistCampaignEvents([std({ idempotency_key: "same" })]);
    await persistCampaignEvents([std({ idempotency_key: "same" })]); // webhook replay
    await persistCampaignEvents([std({ user_id: "user_2", event: "opened" })]);
    const page = await listCampaignEvents({ program_id: "cmp_1", limit: 10 });
    expect(page.events).toHaveLength(2);
  });

  it("never throws — even on malformed rows", async () => {
    // organization_id missing entirely (bad upstream data) → insert would
    // violate NOT NULL; the helper must swallow it.
    const broken = std();
    // @ts-expect-error deliberately malformed
    delete broken.organization_id;
    await expect(persistCampaignEvents([broken])).resolves.toBeUndefined();
  });
});
