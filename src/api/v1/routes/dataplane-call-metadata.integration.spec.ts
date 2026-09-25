/**
 * Call metadata: schemas of keys an api variable attaches, then uses as
 * {{key.k}} / {{key.v}} in its request. The promises that matter: bad schemas
 * are refused with field-level errors, a variable can only use keys of the
 * schema it attached, and nothing in use can be deleted out from under it.
 */

import express, { type Express } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatcherDb } from "../../../db/client.js";
import { listCallMetadata, deleteCallMetadata } from "../../../db/repos/call-metadata.js";
import { listVariables } from "../../../db/repos/variables.js";
import { createTestDb, destroyTestDb } from "../../../db/test-utils.js";
import { resetDispatchConfigForTests, setDispatchConfigForTests } from "../../../user-lookup/config.js";
import { resolveDynamicValues } from "../../../variables/resolver.js";
import { resetPlaceholdersForTests } from "../../../variables/service.js";
import { ATLAS_KEY_ENV } from "../atlas-key.js";
import { registerApiV1Routes, resetApiRateLimitForTests } from "../router.js";

const KEY = "test-atlas-key-0123456789abcdefghijklmnop";
const META = "/api/v1/data-plane/call-metadata";
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
  for (const row of await listCallMetadata()) await deleteCallMetadata(row.name);
  resetApiRateLimitForTests();
});

const gold = {
  name: "gold_metadata",
  keys: [
    { key: "tenure", placeholder: "24", regex: "^\\d+$" },
    { key: "age", placeholder: "36" },
    { key: "limit" },
  ],
};

const createGold = async () => (await api().post(META).set(auth).send(gold)).body.call_metadata;

const apiVariable = (metadata: unknown, apiOverrides: Record<string, unknown> = {}) => ({
  name: "offer",
  definition: {
    source: "api",
    api: {
      method: "GET",
      url: "https://crm.example/offer",
      query: [
        { key: "user_id", value: "{{user_id}}" },
        { key: "{{tenure.k}}", value: "{{tenure.v}}" },
      ],
      json_path: "offer.title",
      metadata,
      ...apiOverrides,
    },
  },
});

describe("schema CRUD", () => {
  it("creates, lists, reads, renames and deletes", async () => {
    const created = await api().post(META).set(auth).send(gold);
    expect(created.status).toBe(201);
    expect(created.body.call_metadata).toMatchObject({
      name: "gold_metadata",
      keys: [
        { key: "tenure", placeholder: "24", regex: "^\\d+$" },
        { key: "age", placeholder: "36" },
        { key: "limit" },
      ],
      used_by: [],
    });

    const list = await api().get(META).set(auth);
    expect(list.body.call_metadata.map((m: { name: string }) => m.name)).toEqual(["gold_metadata"]);

    const renamed = await api().patch(`${META}/gold_metadata`).set(auth).send({ name: "gold" });
    expect(renamed.status).toBe(200);
    expect((await api().get(`${META}/gold`).set(auth)).status).toBe(200);
    expect((await api().get(`${META}/gold_metadata`).set(auth)).status).toBe(404);

    expect((await api().delete(`${META}/gold`).set(auth)).status).toBe(200);
    expect((await api().delete(`${META}/gold`).set(auth)).status).toBe(404);
  });

  it("refuses a duplicate name with 409", async () => {
    await createGold();
    expect((await api().post(META).set(auth).send(gold)).status).toBe(409);
  });

  it.each([
    ["a bad name", { ...gold, name: "gold metadata" }, "name"],
    ["no keys", { ...gold, keys: [] }, "keys"],
    ["a duplicate key", { ...gold, keys: [{ key: "a" }, { key: "a" }] }, "keys.1.key"],
    ["a key that is not an identifier", { ...gold, keys: [{ key: "first-name" }] }, "keys.0.key"],
    ["the reserved key field", { ...gold, keys: [{ key: "field" }] }, "keys.0.key"],
    ["an invalid regex", { ...gold, keys: [{ key: "a", regex: "([" }] }, "keys.0.regex"],
    ["a placeholder its regex rejects", { ...gold, keys: [{ key: "a", placeholder: "abc", regex: "^\\d+$" }] }, "keys.0.placeholder"],
  ])("refuses %s with a field-level error", async (_label, body, path) => {
    const res = await api().post(META).set(auth).send(body);
    expect(res.status).toBe(400);
    expect(res.body.details.map((d: { path: string }) => d.path)).toContain(path);
  });
});

describe("attaching to an api variable", () => {
  it("stores the attachment and shows the schema's current name", async () => {
    const schema = await createGold();
    const res = await api().post(VARS).set(auth).send(apiVariable({ id: schema.id, required: false }));
    expect(res.status).toBe(201);
    expect(res.body.variable.definition.api.metadata).toEqual({
      id: schema.id,
      required: false,
      name: "gold_metadata",
    });

    // Variables hold the id: a rename shows through, nothing breaks.
    await api().patch(`${META}/gold_metadata`).set(auth).send({ name: "gold" });
    const read = await api().get(`${VARS}/offer`).set(auth);
    expect(read.body.variable.definition.api.metadata.name).toBe("gold");
  });

  it("defaults to required", async () => {
    const schema = await createGold();
    const res = await api().post(VARS).set(auth).send(apiVariable({ id: schema.id }));
    expect(res.body.variable.definition.api.metadata.required).toBe(true);
  });

  it("refuses a key that is not in the attached schema, pointing at where it is used", async () => {
    const schema = await createGold();
    const res = await api()
      .post(VARS)
      .set(auth)
      .send(apiVariable({ id: schema.id, required: true }, { body: undefined, url: "https://x.example/{{salary.v}}" }));
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([
      expect.objectContaining({ path: "definition.api.url", message: expect.stringContaining('"salary" is not a key') }),
    ]);
  });

  it("refuses {{key.k}} / {{key.v}} with no schema attached — in names and values", async () => {
    const res = await api().post(VARS).set(auth).send(apiVariable(null));
    expect(res.status).toBe(400);
    expect(res.body.details.map((d: { path: string }) => d.path)).toEqual([
      "definition.api.query.1.key",
      "definition.api.query.1.value",
    ]);
  });

  it("interpolates {{key.k}} in a header name as well", async () => {
    const schema = await createGold();
    const res = await api()
      .post(VARS)
      .set(auth)
      .send(apiVariable({ id: schema.id, required: true }, { query: [], headers: { "X-{{salary.k}}": "1" } }));
    expect(res.status).toBe(400);
    expect(res.body.details[0].path).toBe("definition.api.headers.X-{{salary.k}}");
  });

  it("refuses an unknown schema id", async () => {
    const res = await api().post(VARS).set(auth).send(apiVariable({ id: "nope", required: true }));
    expect(res.status).toBe(400);
    expect(res.body.details[0].path).toBe("definition.api.metadata.id");
  });
});

describe("nothing in use can be pulled out from under a variable", () => {
  it("refuses deleting a schema a variable attaches, and names the variable", async () => {
    const schema = await createGold();
    await api().post(VARS).set(auth).send(apiVariable({ id: schema.id, required: true }));

    const list = await api().get(META).set(auth);
    expect(list.body.call_metadata[0].used_by).toEqual(["offer"]);

    const res = await api().delete(`${META}/gold_metadata`).set(auth);
    expect(res.status).toBe(409);
    expect(res.body.message).toContain("offer");
  });

  it("refuses removing a key a variable uses, but allows removing an unused one", async () => {
    const schema = await createGold();
    await api().post(VARS).set(auth).send(apiVariable({ id: schema.id, required: true }));

    const dropTenure = await api()
      .patch(`${META}/gold_metadata`)
      .set(auth)
      .send({ keys: [{ key: "age" }, { key: "limit" }] });
    expect(dropTenure.status).toBe(409);
    expect(dropTenure.body.details[0].message).toContain("{{tenure.k}}");

    const dropLimit = await api()
      .patch(`${META}/gold_metadata`)
      .set(auth)
      .send({ keys: [{ key: "tenure" }, { key: "age" }] });
    expect(dropLimit.status).toBe(200);
  });

  it("allows the delete once the variable detaches", async () => {
    const schema = await createGold();
    await api().post(VARS).set(auth).send(apiVariable({ id: schema.id, required: true }));
    const detached = await api()
      .patch(`${VARS}/offer`)
      .set(auth)
      .send(apiVariable(null, { query: [{ key: "user_id", value: "{{user_id}}" }] }));
    expect(detached.status).toBe(200);
    expect((await api().delete(`${META}/gold_metadata`).set(auth)).status).toBe(200);
  });
});

describe("what the request sends", () => {
  beforeEach(() => resetPlaceholdersForTests());
  afterEach(() => {
    resetDispatchConfigForTests();
    vi.restoreAllMocks();
  });

  // Without a schema attached there are no values: .v is empty — never the sample.
  it("{{key.k}} is the key name and {{key.v}} is empty", async () => {
    setDispatchConfigForTests({
      user_lookup: { backend: "mock", fields: {} },
      placeholders: {
        offer: {
          source: "api",
          api: {
            method: "GET",
            url: "https://crm.example/offer",
            query: [{ key: "{{tenure.k}}", value: "{{tenure.v}}" }, { key: "k", value: "{{tenure.k}}" }],
            json_path: "t",
          },
        },
      },
    } as never);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response('{"t":"x"}', { status: 200 }));
    await resolveDynamicValues([{ user_id: "u1", email: "", fields: {} }], { campaign_id: "c", organization_id: "o" });
    // {{tenure.k}} works as a parameter name too — the point of `.k`.
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://crm.example/offer?tenure=&k=tenure");
  });

  const offer = (metadata: { id: string; required: boolean }) =>
    setDispatchConfigForTests({
      user_lookup: { backend: "mock", fields: {} },
      placeholders: {
        offer: {
          source: "api",
          api: {
            method: "GET",
            url: "https://crm.example/offer",
            query: [
              { key: "{{tenure.k}}", value: "{{tenure.v}}" },
              { key: "age", value: "{{age.v}}" },
            ],
            json_path: "t",
            metadata,
          },
          fallback: "fb",
        },
      },
    } as never);
  const send = (call_metadata?: { id: string; values: Record<string, string> }) =>
    resolveDynamicValues([{ user_id: "u1", email: "", fields: {} }], {
      campaign_id: "c",
      organization_id: "o",
      call_metadata,
    });
  const respond = () =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response('{"t":"x"}', { status: 200 }));
  const schemaId = async () => (await api().post(META).set(auth).send(gold)).body.call_metadata.id as string;

  it("{{key.v}} is the value the dispatch carries for the attached schema", async () => {
    const id = await schemaId();
    offer({ id, required: true });
    const fetchMock = respond();
    const out = await send({ id, values: { tenure: "24", age: "36", stray: "ignored" } });
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://crm.example/offer?tenure=24&age=36");
    expect(out.get("u1")?.values.offer).toBe("x");
  });

  it("required: a missing value — or one failing its regex — skips the call and falls back", async () => {
    const id = await schemaId();
    offer({ id, required: true });
    const fetchMock = respond();
    expect((await send({ id, values: { tenure: "24" } })).get("u1")?.values.offer).toBe("fb");
    expect((await send({ id, values: { tenure: "two years", age: "36" } })).get("u1")?.fallbacks).toContain("offer");
    // Values for another schema are not this variable's.
    expect((await send({ id: "other", values: { tenure: "24", age: "36" } })).get("u1")?.values.offer).toBe("fb");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("optional: a missing value is sent empty", async () => {
    const id = await schemaId();
    offer({ id, required: false });
    const fetchMock = respond();
    await send();
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://crm.example/offer?tenure=&age=");
  });

  it("the list says which keys a send must supply", async () => {
    const id = await schemaId();
    const required = apiVariable({ id, required: true }, {
      query: [{ key: "{{limit.k}}", value: "{{tenure.v}}" }],
    });
    expect((await api().post(VARS).set(auth).send(required)).status).toBe(201);
    const list = await api().get(META).set(auth);
    expect(list.body.call_metadata[0].required_keys).toEqual(["tenure"]);
  });
});
