import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherDb } from "../client.js";
import { queryDb, tableFor } from "../dialect-helpers.js";
import type { CampaignEventRow } from "../schema/index.js";
import { createTestDb, destroyTestDb } from "../test-utils.js";
import {
  deriveRecipientStatus,
  getCampaignEventAggregates,
  getCampaignFunnel,
  getRecipientStatusCounts,
  insertCampaignEvents,
  listCampaignChannels,
  listCampaignEvents,
  listCampaignSummaries,
  listRecipientRollup,
  listUserTimeline,
} from "./campaign-events.js";

let dbx: DispatcherDb;

beforeEach(async () => {
  dbx = await createTestDb();
});

afterEach(() => {
  destroyTestDb(dbx);
});

const T0 = new Date("2026-07-10T10:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

let seq = 0;
const ev = (partial: Partial<CampaignEventRow>): CampaignEventRow => {
  seq += 1;
  const campaign_id = partial.campaign_id ?? "cmp_1";
  return {
    id: `evt-${seq}`,
    campaign_id,
    // A one-shot campaign is its own program; tests opt into drips explicitly.
    program_id: campaign_id,
    program_kind: "campaign",
    step_id: null,
    organization_id: "org_1",
    user_id: `user-${seq}`,
    channel: "email",
    event: "dispatched",
    provider: "ses",
    provider_message_id: `msg-${seq}`,
    occurred_at: at(seq),
    received_at: at(seq),
    metadata: null,
    dedupe_key: `dk-${seq}`,
    ...partial,
  };
};

async function insertRun(row: Record<string, unknown>): Promise<void> {
  await queryDb(dbx)
    .insert(tableFor(dbx, "dispatchRuns"))
    .values({
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
      duration_ms: 100,
      error_category: null,
      error_message: null,
      error_stack: null,
      occurred_at: T0,
      updated_at: T0,
      ...row,
    });
}

describe("insertCampaignEvents", () => {
  it("dedupes on dedupe_key and survives chunk boundaries", async () => {
    const first = ev({ dedupe_key: "same", user_id: "u1" });
    const dupe = ev({ dedupe_key: "same", user_id: "u1", event: "delivered" });
    // 250 unique rows forces two insert chunks (200 + 50).
    const bulk = Array.from({ length: 250 }, () => ev({}));
    await insertCampaignEvents([first, dupe, ...bulk]);

    const page = await listCampaignEvents({ program_id: "cmp_1", limit: 500 });
    expect(page.events).toHaveLength(251);
    const u1 = page.events.filter((e) => e.user_id === "u1");
    expect(u1).toHaveLength(1);
    expect(u1[0].event).toBe("dispatched"); // first write wins, dupe ignored
  });

  it("re-running the same batch is a no-op", async () => {
    const rows = [ev({}), ev({}), ev({})];
    await insertCampaignEvents(rows);
    await insertCampaignEvents(rows);
    const page = await listCampaignEvents({ program_id: "cmp_1", limit: 10 });
    expect(page.events).toHaveLength(3);
  });
});

describe("listCampaignEvents / listUserTimeline", () => {
  it("filters by event, user, q and pages with a keyset cursor", async () => {
    await insertCampaignEvents([
      ev({ user_id: "alpha", event: "dispatched", occurred_at: at(1), provider_message_id: "m-1" }),
      ev({ user_id: "alpha", event: "delivered", occurred_at: at(2), provider_message_id: "m-1" }),
      ev({ user_id: "beta", event: "dispatched", occurred_at: at(3), provider_message_id: "m-2" }),
      ev({ user_id: "gamma", event: "bounced", occurred_at: at(4), provider_message_id: "m-3" }),
    ]);

    const bounced = await listCampaignEvents({ program_id: "cmp_1", event: "bounced", limit: 10 });
    expect(bounced.events.map((e) => e.user_id)).toEqual(["gamma"]);

    const alpha = await listCampaignEvents({ program_id: "cmp_1", user_id: "alpha", limit: 10 });
    expect(alpha.events).toHaveLength(2);

    const byMsg = await listCampaignEvents({ program_id: "cmp_1", q: "m-2", limit: 10 });
    expect(byMsg.events.map((e) => e.user_id)).toEqual(["beta"]);

    const page1 = await listCampaignEvents({ program_id: "cmp_1", limit: 2 });
    expect(page1.events.map((e) => e.user_id)).toEqual(["gamma", "beta"]);
    expect(page1.next_cursor).not.toBeNull();
    const page2 = await listCampaignEvents({
      program_id: "cmp_1",
      cursor: page1.next_cursor!,
      limit: 2,
    });
    expect(page2.events.map((e) => e.user_id)).toEqual(["alpha", "alpha"]);
    expect(page2.next_cursor).toBeNull();
  });

  it("returns a user's journey oldest-first", async () => {
    await insertCampaignEvents([
      ev({ user_id: "u", event: "delivered", occurred_at: at(2) }),
      ev({ user_id: "u", event: "dispatched", occurred_at: at(1) }),
      ev({ user_id: "u", event: "opened", occurred_at: at(3) }),
      ev({ user_id: "other", event: "dispatched", occurred_at: at(1) }),
    ]);
    const timeline = await listUserTimeline("cmp_1", "u");
    expect(timeline.map((e) => e.event)).toEqual(["dispatched", "delivered", "opened"]);
  });
});

describe("getCampaignFunnel", () => {
  it("counts unique users per stage and keeps read separate from opened", async () => {
    await insertCampaignEvents([
      // u1 full journey with a duplicate open
      ev({ user_id: "u1", event: "dispatched" }),
      ev({ user_id: "u1", event: "delivered" }),
      ev({ user_id: "u1", event: "opened" }),
      ev({ user_id: "u1", event: "opened" }),
      ev({ user_id: "u1", event: "clicked" }),
      // u2 whatsapp read
      ev({ user_id: "u2", event: "dispatched", channel: "whatsapp", provider: "gupshup" }),
      ev({ user_id: "u2", event: "read", channel: "whatsapp", provider: "gupshup" }),
      // u3 bounce
      ev({ user_id: "u3", event: "dispatched" }),
      ev({ user_id: "u3", event: "bounced" }),
      // different campaign must not leak in
      ev({ campaign_id: "cmp_other", user_id: "u9", event: "dispatched" }),
    ]);
    const funnel = await getCampaignFunnel("cmp_1");
    expect(funnel).toEqual({
      unique_recipients: 3,
      dispatched: 3,
      delivered: 1,
      // read is NOT folded into opened — different signals, different trust.
      opened: 1, // u1 only
      read: 1, // u2 (whatsapp)
      clicked: 1,
      bounced: 1,
      complained: 0,
      unsubscribed: 0,
      failed: 0,
    });
  });

  it("aggregates per campaign for the hub page", async () => {
    await insertCampaignEvents([
      ev({ campaign_id: "a", user_id: "u1", event: "dispatched" }),
      ev({ campaign_id: "a", user_id: "u1", event: "delivered" }),
      ev({ campaign_id: "b", user_id: "u2", event: "dispatched" }),
    ]);
    const map = await getCampaignEventAggregates(["a", "b", "missing"]);
    expect(map.get("a")?.delivered).toBe(1);
    expect(map.get("b")?.dispatched).toBe(1);
    expect(map.has("missing")).toBe(false);
  });
});

describe("recipient rollup", () => {
  const seedJourneys = async () => {
    await insertCampaignEvents([
      // clicker: full happy path
      ev({ user_id: "clicker", event: "dispatched", occurred_at: at(1) }),
      ev({ user_id: "clicker", event: "delivered", occurred_at: at(2) }),
      ev({ user_id: "clicker", event: "opened", occurred_at: at(3) }),
      ev({ user_id: "clicker", event: "clicked", occurred_at: at(4) }),
      // bouncer: opened then bounced — precedence must pick bounced
      ev({ user_id: "bouncer", event: "dispatched", occurred_at: at(1) }),
      ev({ user_id: "bouncer", event: "opened", occurred_at: at(2) }),
      ev({ user_id: "bouncer", event: "bounced", occurred_at: at(5) }),
      // reader: whatsapp read only
      ev({ user_id: "reader", event: "read", occurred_at: at(6), channel: "whatsapp" }),
      // sleeper: dispatched only
      ev({ user_id: "sleeper", event: "dispatched", occurred_at: at(7) }),
      // drifter: exotic-only events → pending
      ev({ user_id: "drifter", event: "deferred", occurred_at: at(8) }),
    ]);
  };

  it("derives status by precedence and orders by last activity", async () => {
    await seedJourneys();
    const page = await listRecipientRollup({ program_id: "cmp_1", limit: 10 });
    const byUser = Object.fromEntries(page.recipients.map((r) => [r.user_id, r]));
    expect(byUser.clicker.status).toBe("clicked");
    expect(byUser.bouncer.status).toBe("bounced");
    expect(byUser.reader.status).toBe("read");
    expect(byUser.sleeper.status).toBe("dispatched");
    expect(byUser.drifter.status).toBe("pending");
    // newest last_event_at first
    expect(page.recipients[0].user_id).toBe("drifter");
    expect(byUser.bouncer.event_count).toBe(3);
    expect(byUser.bouncer.first_event_at.getTime()).toBe(at(1).getTime());
    expect(byUser.bouncer.last_event_at.getTime()).toBe(at(5).getTime());
  });

  it("filters by derived status and by user substring", async () => {
    await seedJourneys();
    const bounced = await listRecipientRollup({
      program_id: "cmp_1",
      status: "bounced",
      limit: 10,
    });
    expect(bounced.recipients.map((r) => r.user_id)).toEqual(["bouncer"]);

    const read = await listRecipientRollup({ program_id: "cmp_1", status: "read", limit: 10 });
    expect(read.recipients.map((r) => r.user_id)).toEqual(["reader"]);

    const pending = await listRecipientRollup({
      program_id: "cmp_1",
      status: "pending",
      limit: 10,
    });
    expect(pending.recipients.map((r) => r.user_id)).toEqual(["drifter"]);

    const search = await listRecipientRollup({ program_id: "cmp_1", q: "click", limit: 10 });
    expect(search.recipients.map((r) => r.user_id)).toEqual(["clicker"]);
  });

  it("pages with the HAVING keyset across a shared-timestamp boundary", async () => {
    const sameTs = at(10);
    await insertCampaignEvents(
      ["u-a", "u-b", "u-c", "u-d"].map((user_id) =>
        ev({ user_id, event: "dispatched", occurred_at: sameTs })
      )
    );
    const page1 = await listRecipientRollup({ program_id: "cmp_1", limit: 2 });
    expect(page1.recipients.map((r) => r.user_id)).toEqual(["u-d", "u-c"]);
    const page2 = await listRecipientRollup({
      program_id: "cmp_1",
      cursor: page1.next_cursor!,
      limit: 2,
    });
    expect(page2.recipients.map((r) => r.user_id)).toEqual(["u-b", "u-a"]);
    expect(page2.next_cursor).toBeNull();
  });

  it("produces disjoint status counts that sum to unique recipients", async () => {
    await seedJourneys();
    const counts = await getRecipientStatusCounts("cmp_1");
    expect(counts.clicked).toBe(1);
    expect(counts.bounced).toBe(1);
    expect(counts.read).toBe(1);
    expect(counts.dispatched).toBe(1);
    expect(counts.pending).toBe(1);
    expect(counts.complained + counts.failed + counts.unsubscribed + counts.delivered).toBe(0);
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const funnel = await getCampaignFunnel("cmp_1");
    expect(total).toBe(funnel.unique_recipients);
  });
});

describe("drip programs", () => {
  /**
   * The regression this whole model exists for: ScaleMargin addresses a drip
   * step as `drip_{enrollmentId}_{stepId}`, unique per (sequence x lead x step).
   * Grouping on that wire id would list one "campaign" per recipient per step.
   */
  const seedDrip = async () => {
    const rows: CampaignEventRow[] = [];
    const drip = (user: string, step: string, event: string, channel: string, minute: number) => {
      seq += 1;
      rows.push({
        id: `drip-${seq}`,
        campaign_id: `drip_enr-${user}_${step}`, // the wire id: per recipient, per step
        program_id: "seq_welcome", // the sequence — what a human calls the campaign
        program_kind: "drip",
        step_id: step,
        organization_id: "org_1",
        user_id: user,
        channel,
        event,
        provider: channel === "whatsapp" ? "gupshup" : "ses",
        provider_message_id: `m-${seq}`,
        occurred_at: at(minute),
        received_at: at(minute),
        metadata: null,
        dedupe_key: `dk-drip-${seq}`,
      });
    };
    // 3 recipients x 2 steps, second step switches channel to WhatsApp.
    for (const user of ["u1", "u2", "u3"]) {
      drip(user, "step1", "dispatched", "email", 1);
      drip(user, "step1", "delivered", "email", 2);
    }
    drip("u1", "step1", "opened", "email", 3);
    drip("u1", "step2", "dispatched", "whatsapp", 10);
    drip("u1", "step2", "delivered", "whatsapp", 11);
    drip("u1", "step2", "read", "whatsapp", 12);
    drip("u2", "step2", "dispatched", "whatsapp", 10);
    await insertCampaignEvents(rows);
  };

  it("collapses many wire sends into one program", async () => {
    await seedDrip();
    // 8 distinct wire campaign ids exist…
    const wireIds = new Set(
      (await listCampaignEvents({ program_id: "seq_welcome", limit: 100 })).events.map(
        (e) => e.campaign_id
      )
    );
    expect(wireIds.size).toBe(5); // u1+u2 got both steps, u3 only step1
    // …but they roll up to ONE program with 3 recipients, not 5 campaigns.
    const funnel = await getCampaignFunnel("seq_welcome");
    expect(funnel.unique_recipients).toBe(3);
    expect(funnel.dispatched).toBe(3);
    expect(funnel.opened).toBe(1); // u1 email open
    expect(funnel.read).toBe(1); // u1 whatsapp read — never merged into opened
  });

  it("scopes the funnel to a single step", async () => {
    await seedDrip();
    const step1 = await getCampaignFunnel("seq_welcome", "step1");
    expect(step1.unique_recipients).toBe(3);
    expect(step1.read).toBe(0); // step1 is email-only

    const step2 = await getCampaignFunnel("seq_welcome", "step2");
    expect(step2.unique_recipients).toBe(2); // u1 + u2
    expect(step2.read).toBe(1);
    expect(step2.opened).toBe(0); // whatsapp reports reads, not opens
  });

  it("gives a recipient one journey across steps and channels", async () => {
    await seedDrip();
    const page = await listRecipientRollup({ program_id: "seq_welcome", limit: 10 });
    expect(page.recipients).toHaveLength(3);
    const u1 = page.recipients.find((r) => r.user_id === "u1")!;
    expect(u1.steps).toBe(2);
    expect(u1.channel_count).toBe(2); // email -> whatsapp
    expect(u1.opened).toBe(true);
    expect(u1.read).toBe(true);
    expect(u1.status).toBe("opened"); // opened outranks read for a mixed journey

    const u3 = page.recipients.find((r) => r.user_id === "u3")!;
    expect(u3.steps).toBe(1);
    expect(u3.status).toBe("delivered");

    // The timeline spans both steps in order.
    const timeline = await listUserTimeline("seq_welcome", "u1");
    expect(timeline.map((e) => e.event)).toEqual([
      "dispatched",
      "delivered",
      "opened",
      "dispatched",
      "delivered",
      "read",
    ]);
    expect(timeline.at(-1)?.channel).toBe("whatsapp");
  });
});

describe("deriveRecipientStatus", () => {
  it("walks the precedence order", () => {
    expect(deriveRecipientStatus({ complained: true, clicked: true })).toBe("complained");
    expect(deriveRecipientStatus({ bounced: true, opened: true })).toBe("bounced");
    expect(deriveRecipientStatus({ failed: true, delivered: true })).toBe("failed");
    expect(deriveRecipientStatus({ read: true })).toBe("read");
    expect(deriveRecipientStatus({ opened: true, read: true })).toBe("opened");
    expect(deriveRecipientStatus({ delivered: true })).toBe("delivered");
    expect(deriveRecipientStatus({})).toBe("pending");
  });
});

describe("listCampaignSummaries", () => {
  it("groups dispatch runs per campaign with aggregates", async () => {
    await insertRun({ campaign_id: "cmp_a", program_id: "cmp_a", status: "completed", sent_count: 8, failed_count: 2, recipient_count: 10, occurred_at: at(1), updated_at: at(1) });
    await insertRun({ campaign_id: "cmp_a", program_id: "cmp_a", status: "failed", sent_count: null, failed_count: null, recipient_count: 5, occurred_at: at(3), updated_at: at(3) });
    await insertRun({ campaign_id: "cmp_b", program_id: "cmp_b", status: "accepted", sent_count: null, failed_count: null, recipient_count: 7, occurred_at: at(2), updated_at: at(2) });

    const page = await listCampaignSummaries({ limit: 10 });
    expect(page.campaigns.map((c) => c.program_id)).toEqual(["cmp_a", "cmp_b"]);
    const a = page.campaigns[0];
    expect(a.runs).toBe(2);
    expect(a.failed_runs).toBe(1);
    expect(a.accepted_runs).toBe(0);
    expect(a.recipients).toBe(15);
    expect(a.sent).toBe(8);
    expect(a.failed).toBe(2);
    expect(a.first_activity.getTime()).toBe(at(1).getTime());
    expect(a.last_activity.getTime()).toBe(at(3).getTime());
    expect(a.organization_id).toBe("org_1");
  });

  it("searches by id substring and pages via the HAVING keyset", async () => {
    for (let i = 0; i < 5; i += 1) {
      await insertRun({ campaign_id: `cmp_${i}`, program_id: `cmp_${i}`, occurred_at: at(i), updated_at: at(i) });
    }
    const filtered = await listCampaignSummaries({ q: "cmp_3", limit: 10 });
    expect(filtered.campaigns.map((c) => c.program_id)).toEqual(["cmp_3"]);

    const page1 = await listCampaignSummaries({ limit: 2 });
    expect(page1.campaigns.map((c) => c.program_id)).toEqual(["cmp_4", "cmp_3"]);
    const page2 = await listCampaignSummaries({ cursor: page1.next_cursor!, limit: 2 });
    expect(page2.campaigns.map((c) => c.program_id)).toEqual(["cmp_2", "cmp_1"]);
    const page3 = await listCampaignSummaries({ cursor: page2.next_cursor!, limit: 2 });
    expect(page3.campaigns.map((c) => c.program_id)).toEqual(["cmp_0"]);
    expect(page3.next_cursor).toBeNull();
  });

  it("lists distinct channel/provider pairs for a page of campaigns", async () => {
    await insertRun({ campaign_id: "cmp_a", program_id: "cmp_a", channel: "email", provider: "ses" });
    await insertRun({ campaign_id: "cmp_a", program_id: "cmp_a", channel: "email", provider: "ses" });
    await insertRun({ campaign_id: "cmp_a", program_id: "cmp_a", channel: "whatsapp", provider: "gupshup" });
    await insertRun({ campaign_id: "cmp_b", program_id: "cmp_b", channel: "email", provider: "sendgrid" });
    const pairs = await listCampaignChannels(["cmp_a", "cmp_b"]);
    const key = (p: { program_id: string; channel: string; provider: string }) =>
      `${p.program_id}:${p.channel}:${p.provider}`;
    expect(pairs.map(key).sort()).toEqual([
      "cmp_a:email:ses",
      "cmp_a:whatsapp:gupshup",
      "cmp_b:email:sendgrid",
    ]);
  });
});
