/**
 * Provider message ids: written on send, pruned on the mandatory TTL.
 *
 * The table exists so the company running the dispatcher can query it directly,
 * so the two things that matter are that rows arrive and that they leave when
 * the operator said they should — no earlier.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatcherDb } from "./client.js";
import { queryDb, tableFor } from "./dialect-helpers.js";
import { insertProviderMessageIds } from "./repos/provider-message-ids.js";
import { runRetentionSweep } from "./retention.js";
import { createTestDb, destroyTestDb } from "./test-utils.js";
import { MESSAGE_ID_TTL_SETTING, resetMessageIdTtlForTests } from "../config/message-id-ttl.js";
import { MessageIdRecorder } from "../dispatch/message-id-recorder.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = new Date("2026-07-14T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * HOUR);

let dbx: DispatcherDb;

beforeEach(async () => {
  dbx = await createTestDb();
  resetMessageIdTtlForTests();
});

afterEach(() => {
  destroyTestDb(dbx);
  resetMessageIdTtlForTests();
  vi.unstubAllEnvs();
});

const row = (id: string, provider: string, messageId: string, sent_at: Date) => ({
  id,
  provider,
  provider_message_id: messageId,
  user_id: `user_${id}`,
  sent_at,
});

async function idsInTable(): Promise<string[]> {
  const t = tableFor(dbx, "providerMessageIds");
  const rows: Array<{ provider_message_id: string }> = await queryDb(dbx)
    .select({ provider_message_id: t.provider_message_id })
    .from(t);
  return rows.map((r) => r.provider_message_id).sort();
}

describe("writing", () => {
  it("stores provider, message id, user id and sent_at", async () => {
    await insertProviderMessageIds([
      row("a", "freshchat", "req_abc123", hoursAgo(1)),
    ]);
    const t = tableFor(dbx, "providerMessageIds");
    const rows: Array<Record<string, unknown>> = await queryDb(dbx).select().from(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "freshchat",
      provider_message_id: "req_abc123",
      user_id: "user_a",
    });
    expect(new Date(rows[0].sent_at as string | number).getTime()).toBe(hoursAgo(1).getTime());
  });

  it("writes nothing for an empty batch", async () => {
    await insertProviderMessageIds([]);
    expect(await idsInTable()).toEqual([]);
  });
});

describe("the recorder", () => {
  it("collects accepted sends and flushes them once", async () => {
    const recorder = new MessageIdRecorder();
    recorder.add("freshchat", "req_1", "u1");
    recorder.add("freshchat", "req_2", "u2");
    recorder.flush();
    await vi.waitFor(async () => expect(await idsInTable()).toEqual(["req_1", "req_2"]));

    const t = tableFor(dbx, "providerMessageIds");
    const rows: Array<{ id: string; user: string }> = await queryDb(dbx)
      .select({ id: t.provider_message_id, user: t.user_id })
      .from(t);
    expect(rows.sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: "req_1", user: "u1" },
      { id: "req_2", user: "u2" },
    ]);
  });

  // A rejected send has no id to look up; a null row would be noise in a table
  // whose only purpose is "here are the ids we were given".
  it.each([null, undefined, "", "   "])("ignores a missing id (%s)", async (id) => {
    const recorder = new MessageIdRecorder();
    recorder.add("freshchat", id as string | null | undefined, "u1");
    recorder.flush();
    expect(await idsInTable()).toEqual([]);
  });

  it("records the provider that actually sent, not a hard-coded one", async () => {
    const recorder = new MessageIdRecorder();
    recorder.add("freshchat", "fc_1", "u1");
    recorder.add("gupshup", "gs_1", "u2");
    recorder.flush();
    await vi.waitFor(async () => expect(await idsInTable()).toEqual(["fc_1", "gs_1"]));

    const t = tableFor(dbx, "providerMessageIds");
    const rows: Array<{ provider: string }> = await queryDb(dbx)
      .select({ provider: t.provider })
      .from(t);
    expect(rows.map((r) => r.provider).sort()).toEqual(["freshchat", "gupshup"]);
  });
});

describe("pruning", () => {
  it("deletes rows older than the TTL and keeps the rest", async () => {
    vi.stubEnv(MESSAGE_ID_TTL_SETTING, "2h");
    await insertProviderMessageIds([
      row("a", "freshchat", "three_hours_old", hoursAgo(3)),
      row("b", "freshchat", "one_hour_old", hoursAgo(1)),
    ]);

    await runRetentionSweep(now);

    expect(await idsInTable()).toEqual(["one_hour_old"]);
  });

  it("honours a compound window", async () => {
    vi.stubEnv(MESSAGE_ID_TTL_SETTING, "5d 2h");
    await insertProviderMessageIds([
      row("a", "freshchat", "older", new Date(now.getTime() - (5 * DAY + 3 * HOUR))),
      row("b", "freshchat", "newer", new Date(now.getTime() - (5 * DAY + HOUR))),
    ]);

    await runRetentionSweep(now);

    expect(await idsInTable()).toEqual(["newer"]);
  });

  // The operator chose a duration. Deleting inside it because some other
  // threshold was reached would make the setting a lie.
  it("never deletes a row younger than the window", async () => {
    vi.stubEnv(MESSAGE_ID_TTL_SETTING, "30d");
    const rows = Array.from({ length: 50 }, (_, i) =>
      row(`r${i}`, "freshchat", `id_${i}`, hoursAgo(i))
    );
    await insertProviderMessageIds(rows);

    await runRetentionSweep(now);

    expect(await idsInTable()).toHaveLength(50);
  });

  it("leaves other tables' rows alone", async () => {
    vi.stubEnv(MESSAGE_ID_TTL_SETTING, "1h");
    await insertProviderMessageIds([row("a", "freshchat", "gone", hoursAgo(5))]);
    await expect(runRetentionSweep(now)).resolves.not.toThrow();
    expect(await idsInTable()).toEqual([]);
  });
});
