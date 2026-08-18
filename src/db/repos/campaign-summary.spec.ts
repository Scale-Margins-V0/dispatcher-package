/**
 * The rollup's two load-bearing claims:
 *
 *   1. **Idempotent.** Recomputing must never change the answer — that is the
 *      whole reason it is a recompute and not an increment.
 *   2. **Monotonic.** Once campaign_events is pruned the funnel recomputes to
 *      zero; the stored totals must not follow it down.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherDb } from "../client.js";
import { getDb } from "../client.js";
import { queryDb, tableFor } from "../dialect-helpers.js";
import { createTestDb, destroyTestDb } from "../test-utils.js";
import { upsertDispatchRun } from "./activity.js";
import { insertCampaignEvents } from "./campaign-events.js";
import {
  getCampaignSummary,
  listCampaignSummaries,
  rebuildAllCampaignSummaries,
  refreshCampaignSummary,
  sumRunsForProgram,
} from "./campaign-summary.js";
import { insertSendLogs } from "./send-logs.js";
import type { CampaignEventRow, DispatchRunRow, SendLogRow } from "../schema/index.js";

let dbx: DispatcherDb;

const at = (minutes: number) => new Date(Date.UTC(2026, 7, 17, 9, minutes, 0));

beforeEach(async () => {
  dbx = await createTestDb();
});

afterEach(() => {
  destroyTestDb(dbx);
});

function run(overrides: Partial<DispatchRunRow> = {}): Omit<DispatchRunRow, "updated_at"> {
  return {
    id: crypto.randomUUID(),
    campaign_id: "cmp_1",
    program_id: "cmp_1",
    program_kind: "campaign",
    step_id: null,
    organization_id: "org_1",
    channel: "email",
    provider: "ses",
    status: "completed",
    recipient_count: 10,
    sent_count: 9,
    failed_count: 1,
    duration_ms: 1200,
    resolution_total: 20,
    resolution_fallbacks: 3,
    error_category: null,
    error_message: null,
    error_stack: null,
    occurred_at: at(1),
    ...overrides,
  };
}

function event(overrides: Partial<CampaignEventRow> = {}): CampaignEventRow {
  const id = crypto.randomUUID();
  return {
    id,
    campaign_id: "cmp_1",
    program_id: "cmp_1",
    program_kind: "campaign",
    step_id: null,
    organization_id: "org_1",
    user_id: "u1",
    channel: "email",
    event: "delivered",
    provider: "ses",
    provider_message_id: null,
    occurred_at: at(2),
    received_at: at(2),
    metadata: null,
    dedupe_key: id,
    ...overrides,
  };
}

function sendLog(overrides: Partial<SendLogRow> = {}): SendLogRow {
  return {
    id: crypto.randomUUID(),
    dispatch_run_id: "run_1",
    campaign_id: "cmp_1",
    program_id: "cmp_1",
    step_id: null,
    organization_id: "org_1",
    user_id: "u1",
    channel: "email",
    provider: "ses",
    template_ref: "welcome-v2",
    status: "sent",
    provider_message_id: "msg-1",
    latency_ms: 120,
    error_category: null,
    error_message: null,
    fallbacks_used: 1,
    occurred_at: at(2),
    ...overrides,
  };
}

async function clearEvents(): Promise<void> {
  const db = getDb();
  await queryDb(db).delete(tableFor(db, "campaignEvents"));
}

describe("sumRunsForProgram", () => {
  it("returns null for a program that has never run", async () => {
    expect(await sumRunsForProgram("nope")).toBeNull();
  });

  it("sums completed runs only", async () => {
    await upsertDispatchRun(run({ occurred_at: at(1) }));
    await upsertDispatchRun(run({ occurred_at: at(2) }));
    // Still in flight — its null counters must not be treated as zero sends.
    await upsertDispatchRun(
      run({ status: "accepted", sent_count: null, failed_count: null, occurred_at: at(3) })
    );

    const totals = await sumRunsForProgram("cmp_1");
    expect(totals).toMatchObject({
      total_recipients: 20,
      sent: 18,
      failed: 2,
      resolution_total: 40,
      resolution_fallbacks: 6,
      runs: 2,
      channel: "email",
      provider: "ses",
    });
  });
});

describe("refreshCampaignSummary", () => {
  it("rolls runs and events into one row", async () => {
    await upsertDispatchRun(run());
    await insertCampaignEvents([
      event({ user_id: "u1", event: "dispatched" }),
      event({ user_id: "u1", event: "delivered" }),
      event({ user_id: "u1", event: "opened" }),
      event({ user_id: "u2", event: "dispatched" }),
      event({ user_id: "u2", event: "delivered" }),
      event({ user_id: "u2", event: "clicked" }),
      event({ user_id: "u3", event: "bounced" }),
    ]);
    await insertSendLogs([sendLog()]);

    await refreshCampaignSummary("cmp_1");
    const summary = await getCampaignSummary("cmp_1");

    expect(summary).toMatchObject({
      program_id: "cmp_1",
      program_kind: "campaign",
      organization_id: "org_1",
      channel: "email",
      provider: "ses",
      template_ref: "welcome-v2",
      total_recipients: 10,
      sent: 9,
      failed: 1,
      fallbacks_used: 3,
      unique_recipients: 3,
      dispatched: 2,
      delivered: 2,
      opened: 1,
      clicked: 1,
      bounced: 1,
    });
  });

  it("counts a WhatsApp read as an open", async () => {
    await upsertDispatchRun(run({ channel: "whatsapp", provider: "gupshup" }));
    await insertCampaignEvents([
      event({ user_id: "u1", channel: "whatsapp", provider: "gupshup", event: "read" }),
    ]);

    await refreshCampaignSummary("cmp_1");
    expect((await getCampaignSummary("cmp_1"))?.opened).toBe(1);
  });

  it("is idempotent — recomputing changes nothing", async () => {
    await upsertDispatchRun(run());
    await insertCampaignEvents([
      event({ user_id: "u1", event: "delivered" }),
      event({ user_id: "u2", event: "delivered" }),
    ]);

    await refreshCampaignSummary("cmp_1");
    const first = await getCampaignSummary("cmp_1");
    await refreshCampaignSummary("cmp_1");
    await refreshCampaignSummary("cmp_1");
    const third = await getCampaignSummary("cmp_1");

    // updated_at is expected to move; nothing else may.
    const { updated_at: _a, ...firstCounters } = first!;
    const { updated_at: _b, ...thirdCounters } = third!;
    expect(thirdCounters).toEqual(firstCounters);
  });

  it("does not lower counters when the events behind them are pruned", async () => {
    await upsertDispatchRun(run());
    await insertCampaignEvents([
      event({ user_id: "u1", event: "delivered" }),
      event({ user_id: "u2", event: "delivered" }),
      event({ user_id: "u3", event: "clicked" }),
    ]);
    await refreshCampaignSummary("cmp_1");
    expect((await getCampaignSummary("cmp_1"))?.delivered).toBe(2);

    // Retention sweeps the events away, then a late webhook lands.
    await clearEvents();
    await refreshCampaignSummary("cmp_1");

    const after = await getCampaignSummary("cmp_1");
    expect(after?.delivered).toBe(2);
    expect(after?.clicked).toBe(1);
    expect(after?.unique_recipients).toBe(3);
  });

  it("still raises a counter when a genuinely new event arrives", async () => {
    await upsertDispatchRun(run());
    await insertCampaignEvents([event({ user_id: "u1", event: "delivered" })]);
    await refreshCampaignSummary("cmp_1");
    expect((await getCampaignSummary("cmp_1"))?.delivered).toBe(1);

    await insertCampaignEvents([event({ user_id: "u2", event: "delivered" })]);
    await refreshCampaignSummary("cmp_1");
    expect((await getCampaignSummary("cmp_1"))?.delivered).toBe(2);
  });

  it("writes nothing for a program with no runs and no existing row", async () => {
    await refreshCampaignSummary("ghost");
    expect(await getCampaignSummary("ghost")).toBeNull();
  });

  it("keeps drip steps under one program", async () => {
    await upsertDispatchRun(
      run({ campaign_id: "drip_e1_s1", program_id: "seq_1", program_kind: "drip", step_id: "s1", recipient_count: 1, sent_count: 1, failed_count: 0 })
    );
    await upsertDispatchRun(
      run({ campaign_id: "drip_e2_s2", program_id: "seq_1", program_kind: "drip", step_id: "s2", recipient_count: 1, sent_count: 1, failed_count: 0, occurred_at: at(4) })
    );

    await refreshCampaignSummary("seq_1");
    expect(await getCampaignSummary("seq_1")).toMatchObject({
      program_kind: "drip",
      total_recipients: 2,
      sent: 2,
    });
  });
});

describe("rebuildAllCampaignSummaries", () => {
  it("backfills every program that has ever run", async () => {
    await upsertDispatchRun(run({ program_id: "cmp_1", campaign_id: "cmp_1" }));
    await upsertDispatchRun(run({ program_id: "cmp_2", campaign_id: "cmp_2" }));
    await insertCampaignEvents([event({ program_id: "cmp_2", campaign_id: "cmp_2" })]);

    const { rebuilt } = await rebuildAllCampaignSummaries();
    expect(rebuilt).toBe(2);
    expect(await getCampaignSummary("cmp_1")).not.toBeNull();
    expect(await getCampaignSummary("cmp_2")).not.toBeNull();
  });
});

describe("listCampaignSummaries", () => {
  beforeEach(async () => {
    await upsertDispatchRun(run({ program_id: "cmp_email", campaign_id: "cmp_email" }));
    await upsertDispatchRun(
      run({
        program_id: "cmp_wa",
        campaign_id: "cmp_wa",
        channel: "whatsapp",
        provider: "gupshup",
        organization_id: "org_2",
        occurred_at: at(5),
      })
    );
    await rebuildAllCampaignSummaries();
  });

  it("filters by channel, organization and name", async () => {
    expect(await listCampaignSummaries({ channel: "whatsapp" })).toHaveLength(1);
    expect(await listCampaignSummaries({ organization_id: "org_2" })).toHaveLength(1);
    expect(await listCampaignSummaries({ q: "email" })).toHaveLength(1);
    expect(await listCampaignSummaries({})).toHaveLength(2);
  });

  it("orders by most recent activity first", async () => {
    const rows = await listCampaignSummaries({});
    expect(rows.map((r) => r.program_id)).toEqual(["cmp_wa", "cmp_email"]);
  });
});
