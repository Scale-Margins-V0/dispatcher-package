/**
 * Saving API response values against the sent message (api variable
 * `save_response`). The promises: bad configs are refused with field-level
 * errors, saved paths are read from the response even when no template uses
 * them, only real values for the named provider are written, and they are
 * pruned on message_id_ttl like the message ids they key on.
 */
import express, { type Express } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatcherDb } from "../../../db/client.js";
import { queryDb, tableFor } from "../../../db/dialect-helpers.js";
import { runRetentionSweep } from "../../../db/retention.js";
import { listVariables } from "../../../db/repos/variables.js";
import { createTestDb, destroyTestDb } from "../../../db/test-utils.js";
import { MESSAGE_ID_TTL_SETTING, resetMessageIdTtlForTests } from "../../../config/message-id-ttl.js";
import { ResponseRefRecorder, savedValues } from "../../../dispatch/response-ref-recorder.js";
import { resetDispatchConfigForTests, setDispatchConfigForTests } from "../../../user-lookup/config.js";
import { rowToPlaceholderEntry } from "../../../variables/mapping.js";
import { resolveDynamicValues } from "../../../variables/resolver.js";
import { resetPlaceholdersForTests } from "../../../variables/service.js";
import { ATLAS_KEY_ENV } from "../atlas-key.js";
import { registerApiV1Routes, resetApiRateLimitForTests } from "../router.js";

const KEY = "test-atlas-key-0123456789abcdefghijklmnop";
const VARS = "/api/v1/data-plane/variables";
const auth = { Authorization: `Bearer ${KEY}` };

let app: Express;
let dbx: DispatcherDb;
let savedKey: string | undefined;
const api = () => request(app);

beforeAll(async () => {
  savedKey = process.env[ATLAS_KEY_ENV];
  process.env[ATLAS_KEY_ENV] = KEY;
  dbx = await createTestDb();
  app = express();
  registerApiV1Routes(app);
});
afterAll(() => {
  if (savedKey === undefined) delete process.env[ATLAS_KEY_ENV];
  else process.env[ATLAS_KEY_ENV] = savedKey;
  destroyTestDb(dbx);
});
beforeEach(async () => {
  resetApiRateLimitForTests();
  for (const row of await listVariables()) await api().delete(`${VARS}/${row.name}`).set(auth);
  resetApiRateLimitForTests();
});

const offerVariable = (save_response: unknown, extra: Record<string, unknown> = {}) => ({
  name: "offer",
  definition: {
    source: "api",
    api: {
      method: "GET",
      url: "https://crm.example/offer",
      query: [{ key: "user_id", value: "{{user_id}}" }],
      json_path: "offer.title",
      save_response,
      ...extra,
    },
  },
});
const create = (body: object) => api().post(VARS).set(auth).send(body);
const messages = (res: request.Response) => JSON.stringify(res.body);

describe("configuring save_response", () => {
  it("stores it and returns it on read", async () => {
    const res = await create(offerVariable({ provider: "freshchat", paths: ["offer.id", "offer.code"] }));
    expect(res.status).toBe(201);
    const got = await api().get(`${VARS}/offer`).set(auth);
    expect(got.body.variable.definition.api.save_response).toEqual({ provider: "freshchat", paths: ["offer.id", "offer.code"] });
  });

  it("refuses more than 5 paths, an unknown provider, a bad path and a duplicate", async () => {
    const six = ["a", "b", "c", "d", "e", "f"];
    expect(messages(await create(offerVariable({ provider: "freshchat", paths: six })))).toContain("At most 5 response paths");
    expect(messages(await create(offerVariable({ provider: "gupshup", paths: ["a"] })))).toContain("only be saved for: freshchat");
    expect(messages(await create(offerVariable({ provider: "freshchat", paths: ["offer..id"] })))).toContain("dot-separated keys");
    expect(messages(await create(offerVariable({ provider: "freshchat", paths: ["a", "a"] })))).toContain('is listed twice');
    expect(messages(await create(offerVariable({ provider: "freshchat", paths: [] })))).toContain("at least one response path");
  });

  it("refuses a path that is an object in the described response", async () => {
    const res = await create(
      offerVariable({ provider: "freshchat", paths: ["offer"] }, { response_sample: '{"offer":{"id":"OF-1","title":"t"}}' })
    );
    expect(res.status).toBe(400);
    expect(messages(res)).toContain("is an object");
  });

  it("can be turned off again with null", async () => {
    await create(offerVariable({ provider: "freshchat", paths: ["offer.id"] }));
    const res = await api().patch(`${VARS}/offer`).set(auth).send({ definition: offerVariable(null).definition });
    expect(res.status).toBe(200);
    expect(res.body.variable.definition.api.save_response ?? null).toBeNull();
  });

  it("the stored row maps to a runtime entry — and a malformed block maps to nothing", () => {
    const row = (config: unknown) =>
      rowToPlaceholderEntry({ name: "offer", source: "api", field: null, expr: null, fallback: null, config } as never);
    const ok = row({ url: "u", json_path: "", save_response: { provider: "freshchat", paths: ["offer.id", "bad..path"] } });
    expect(ok.source === "api" && ok.api.save_response).toEqual({ provider: "freshchat", paths: ["offer.id"] });
    const unknown = row({ url: "u", json_path: "", save_response: { provider: "sms", paths: ["offer.id"] } });
    expect(unknown.source === "api" && unknown.api.save_response).toBeUndefined();
  });
});

describe("at send time", () => {
  beforeEach(() => {
    resetPlaceholdersForTests();
    setDispatchConfigForTests({
      user_lookup: { backend: "mock", fields: {} },
      placeholders: {
        offer: {
          source: "api",
          api: {
            method: "GET",
            url: "https://crm.example/offer",
            json_path: "offer.title",
            save_response: { provider: "freshchat", paths: ["offer.id", "offer.code", "offer.missing"] },
          },
          fallback: "fb",
        },
      },
    } as never);
  });
  afterEach(() => {
    resetDispatchConfigForTests();
    vi.restoreAllMocks();
    resetMessageIdTtlForTests();
    vi.unstubAllEnvs();
  });

  const resolveFor = async (body: string) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(body, { status: 200 }));
    // No template content at all: the saved paths must still be read.
    return (await resolveDynamicValues([{ user_id: "u1", email: "", fields: {} }], { campaign_id: "c", organization_id: "o" })).get("u1");
  };
  const refRows = async () => {
    await new Promise((r) => setTimeout(r, 20)); // flush() is fire-and-forget
    const t = tableFor(dbx, "apiResponseRefs");
    return (await queryDb(dbx).select().from(t)) as Array<Record<string, unknown>>;
  };
  const clearRefs = async () => queryDb(dbx).delete(tableFor(dbx, "apiResponseRefs"));

  it("reads saved paths from the response even when no template uses them", async () => {
    const res = await resolveFor('{"offer":{"id":"OF-1","code":"C9","title":"Gold"}}');
    expect(res?.values["offer.offer.id"]).toBe("OF-1");
    expect(res?.values["offer.offer.code"]).toBe("C9");
  });

  it("saves real values against the Freshchat message, with its campaign, template and sender", async () => {
    await clearRefs();
    const resolution = await resolveFor('{"offer":{"id":"OF-1","code":"C9","title":"Gold"}}');
    const rec = new ResponseRefRecorder({ campaignId: "drip_seq_step", organizationId: "org_1", channel: "whatsapp" });
    rec.add({ provider: "freshchat", providerMessageId: "req-1", userId: "u1", senderId: "fc_main", templateName: "welcome_v1", resolution });
    rec.flush();
    const rows = await refRows();
    expect(rows.map((r) => [r.path, r.value]).sort()).toEqual([
      ["offer.code", "C9"],
      ["offer.id", "OF-1"],
    ]); // offer.missing fell back — never saved
    expect(rows[0]).toMatchObject({
      provider: "freshchat",
      provider_message_id: "req-1",
      channel: "whatsapp",
      user_id: "u1",
      organization_id: "org_1",
      campaign_id: "drip_seq_step",
      template_name: "welcome_v1",
      sender_id: "fc_main",
      variable_name: "offer",
    });
  });

  it("saves nothing when another provider sent it, when the API failed, or without a message id", async () => {
    await clearRefs();
    const good = await resolveFor('{"offer":{"id":"OF-1"}}');
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("down", { status: 503 }));
    const failed = (await resolveDynamicValues([{ user_id: "u2", email: "", fields: {} }], { campaign_id: "c", organization_id: "o" })).get("u2");
    const rec = new ResponseRefRecorder({ campaignId: "c", organizationId: null, channel: "whatsapp" });
    rec.add({ provider: "gupshup", providerMessageId: "g-1", userId: "u1", senderId: "gs", templateName: null, resolution: good });
    rec.add({ provider: "freshchat", providerMessageId: "req-2", userId: "u2", senderId: "fc", templateName: null, resolution: failed });
    rec.add({ provider: "freshchat", providerMessageId: "  ", userId: "u1", senderId: "fc", templateName: null, resolution: good });
    rec.flush();
    expect(await refRows()).toEqual([]);
  });

  it("skips a value too long for the column rather than truncating it", () => {
    const long = "x".repeat(192);
    const out = savedValues([{ variable: "offer", provider: "freshchat", paths: ["offer.id"] }], "freshchat", {
      values: { "offer.offer.id": long },
      fallbacks: [],
    });
    expect(out).toEqual({ values: [], tooLong: ["offer.offer.id"] });
  });

  it("is pruned on message_id_ttl, with the message ids", async () => {
    await clearRefs();
    vi.stubEnv(MESSAGE_ID_TTL_SETTING, "2h");
    resetMessageIdTtlForTests();
    const now = new Date("2026-09-29T12:00:00Z");
    const t = tableFor(dbx, "apiResponseRefs");
    const base = { provider: "freshchat", channel: "whatsapp", user_id: "u", organization_id: null, campaign_id: "c", template_name: null, sender_id: null, variable_name: "offer", path: "offer.id", value: "v" };
    await queryDb(dbx).insert(t).values([
      { ...base, id: "old", provider_message_id: "old", sent_at: new Date(now.getTime() - 3 * 3600_000) },
      { ...base, id: "new", provider_message_id: "new", sent_at: new Date(now.getTime() - 1 * 3600_000) },
    ]);
    await runRetentionSweep(now);
    expect((await refRows()).map((r) => r.id)).toEqual(["new"]);
  });
});
