/**
 * Contract tests for the data-plane variable CRUD surface.
 *
 * The promises worth pinning down: the wire shape Atlas builds forms against,
 * validation that rejects before anything is written, secrets that go out
 * masked and survive a round trip, and samples that are rendered for the
 * sources we can render without touching the client's data.
 */

import express, { type Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { DispatcherDb } from "../../../db/client.js";
import { listVariables } from "../../../db/repos/variables.js";
import { createTestDb, destroyTestDb } from "../../../db/test-utils.js";
import { ATLAS_KEY_ENV } from "../atlas-key.js";
import { registerApiV1Routes, resetApiRateLimitForTests } from "../router.js";
import { HEADER_MASK } from "../validators/dataplane.validator.js";

const KEY = "test-atlas-key-0123456789abcdefghijklmnop";
const BASE = "/api/v1/data-plane/variables";

let app: Express;
let dbx: DispatcherDb;
let savedKey: string | undefined;

const auth = { Authorization: `Bearer ${KEY}` };
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
  for (const row of await listVariables()) {
    await api().delete(`${BASE}/${row.name}`).set(auth);
  }
  resetApiRateLimitForTests();
});

describe("auth", () => {
  it("refuses an unauthenticated read", async () => {
    const res = await api().get(BASE);
    expect(res.status).toBe(401);
  });
});

describe("create", () => {
  it("creates a field variable and renders its sample", async () => {
    const res = await api()
      .post(BASE)
      .set(auth)
      .send({ name: "first_name", definition: { source: "field", field: "first_name" } });

    expect(res.status).toBe(201);
    expect(res.body.variable).toMatchObject({
      name: "first_name",
      source: "field",
      definition: { source: "field", field: "first_name" },
      enabled: true,
      // Rendered against the fictional record, not a real one.
      sample: "Ada",
    });
  });

  it("renders a computed sample from the sample record", async () => {
    const res = await api()
      .post(BASE)
      .set(auth)
      .send({
        name: "welcome_line",
        definition: { source: "computed", expr: "'Welcome back to ' + company_name" },
      });

    expect(res.status).toBe(201);
    expect(res.body.variable.sample).toBe("Welcome back to Acme Corp");
  });

  it("keeps the caller's sample for a query variable rather than running the SQL", async () => {
    const res = await api()
      .post(BASE)
      .set(auth)
      .send({
        name: "available_credit",
        definition: {
          source: "query",
          sql: "SELECT limit_amount - drawn_amount FROM credit_accounts WHERE user_ref = {{user_id}}",
        },
        fallback: "your current limit",
        sample: "48,250.00",
      });

    expect(res.status).toBe(201);
    expect(res.body.variable.sample).toBe("48,250.00");
    expect(res.body.variable.fallback).toBe("your current limit");
  });

  it("rejects a duplicate name with 409", async () => {
    const body = { name: "season_label", definition: { source: "constant", value: "Winter" } };
    expect((await api().post(BASE).set(auth).send(body)).status).toBe(201);

    const res = await api().post(BASE).set(auth).send(body);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("conflict");
  });
});

describe("validation", () => {
  const invalid: Array<[string, Record<string, unknown>, string]> = [
    [
      "a name with a space",
      { name: "first name", definition: { source: "field", field: "first_name" } },
      "name",
    ],
    [
      "an unknown source",
      { name: "x", definition: { source: "magic", value: "1" } },
      "definition.source",
    ],
    [
      "a non-SELECT statement",
      { name: "x", definition: { source: "query", sql: "DELETE FROM users" } },
      "definition.sql",
    ],
    [
      "a stacked statement",
      { name: "x", definition: { source: "query", sql: "SELECT 1; DROP TABLE users" } },
      "definition.sql",
    ],
    [
      "an expression the evaluator rejects",
      { name: "x", definition: { source: "computed", expr: "process.exit()" } },
      "definition.expr",
    ],
    [
      "a non-http api url",
      { name: "x", definition: { source: "api", api: { url: "file:///etc/passwd", json_path: "" } } },
      "definition.api.url",
    ],
    [
      "a field definition missing its column",
      { name: "x", definition: { source: "field" } },
      "definition.field",
    ],
  ];

  it.each(invalid)("rejects %s", async (_label, body, path) => {
    const res = await api().post(BASE).set(auth).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.details.some((d: { path: string }) => d.path === path)).toBe(true);
  });

  it("rejects an empty update body", async () => {
    await api()
      .post(BASE)
      .set(auth)
      .send({ name: "x", definition: { source: "constant", value: "1" } });

    const res = await api().patch(`${BASE}/x`).set(auth).send({});
    expect(res.status).toBe(400);
  });

  it("does not write anything when validation fails", async () => {
    await api().post(BASE).set(auth).send({ name: "bad name", definition: { source: "field", field: "a" } });
    expect(await listVariables()).toHaveLength(0);
  });
});

describe("api secrets", () => {
  const definition = {
    source: "api",
    api: {
      method: "GET",
      url: "https://crm.internal/users/{{user_id}}",
      headers: { Authorization: "Bearer super-secret-token" },
      json_path: "tier",
    },
  };

  it("masks header values on the way out", async () => {
    const created = await api().post(BASE).set(auth).send({ name: "loyalty_tier", definition });

    expect(created.status).toBe(201);
    expect(created.body.variable.definition.api.headers).toEqual({ Authorization: HEADER_MASK });
    expect(JSON.stringify(created.body)).not.toContain("super-secret-token");
  });

  it("preserves the stored secret when the mask is sent back", async () => {
    await api().post(BASE).set(auth).send({ name: "loyalty_tier", definition });

    const res = await api()
      .patch(`${BASE}/loyalty_tier`)
      .set(auth)
      .send({
        definition: {
          ...definition,
          api: { ...definition.api, json_path: "grade", headers: { Authorization: HEADER_MASK } },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.variable.definition.api.json_path).toBe("grade");

    const stored = (await listVariables()).find((row) => row.name === "loyalty_tier");
    expect((stored?.config as { headers: Record<string, string> }).headers.Authorization).toBe(
      "Bearer super-secret-token"
    );
  });

  it("refuses a mask on create, where there is no secret to preserve", async () => {
    const res = await api()
      .post(BASE)
      .set(auth)
      .send({
        name: "loyalty_tier",
        definition: { ...definition, api: { ...definition.api, headers: { Authorization: HEADER_MASK } } },
      });

    expect(res.status).toBe(400);
  });
});

describe("pagination", () => {
  beforeEach(async () => {
    // v_01 … v_07, created in order so the name sort is predictable.
    for (let i = 1; i <= 7; i++) {
      await api()
        .post(BASE)
        .set(auth)
        .send({
          name: `v_${String(i).padStart(2, "0")}`,
          definition: { source: "constant", value: String(i) },
        });
    }
  });

  it("cuts the requested page and reports where it sits", async () => {
    const res = await api().get(`${BASE}?page=2&limit=3`).set(auth);

    expect(res.status).toBe(200);
    expect(res.body.variables.map((v: { name: string }) => v.name)).toEqual(["v_04", "v_05", "v_06"]);
    expect(res.body.meta).toEqual({
      page: 2,
      limit: 3,
      total: 7,
      total_pages: 3,
      from: 4,
      to: 6,
      has_previous_page: true,
      has_next_page: true,
    });
  });

  it("reports the last page as having no next", async () => {
    const res = await api().get(`${BASE}?page=3&limit=3`).set(auth);
    expect(res.body.variables).toHaveLength(1);
    expect(res.body.meta).toMatchObject({ from: 7, to: 7, has_next_page: false, has_previous_page: true });
  });

  it("returns an empty page past the end rather than a 404", async () => {
    const res = await api().get(`${BASE}?page=9&limit=3`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.variables).toEqual([]);
    expect(res.body.meta).toMatchObject({
      page: 9,
      total: 7,
      total_pages: 3,
      from: null,
      to: null,
      has_next_page: false,
    });
  });

  it("paginates the filtered set, not the whole table", async () => {
    await api()
      .post(BASE)
      .set(auth)
      .send({ name: "keep_me", definition: { source: "field", field: "first_name" } });

    const res = await api().get(`${BASE}?source=field&limit=2`).set(auth);
    expect(res.body.meta).toMatchObject({ total: 1, total_pages: 1 });
    expect(res.body.variables).toHaveLength(1);
  });

  it("floors total_pages at 1 when nothing matches", async () => {
    const res = await api().get(`${BASE}?q=nothing_matches_this`).set(auth);
    expect(res.body.variables).toEqual([]);
    expect(res.body.meta).toMatchObject({
      page: 1,
      total: 0,
      total_pages: 1,
      from: null,
      to: null,
      has_previous_page: false,
      has_next_page: false,
    });
  });

  const badQueries: Array<[string, string, string]> = [
    ["page 0", "page=0", "page"],
    ["a negative page", "page=-1", "page"],
    ["a fractional page", "page=1.5", "page"],
    ["a non-numeric page", "page=abc", "page"],
    ["limit 0", "limit=0", "limit"],
    ["a limit above the cap", "limit=101", "limit"],
    ["an empty page value", "page=", "page"],
  ];

  it.each(badQueries)("rejects %s", async (_label, query, path) => {
    const res = await api().get(`${BASE}?${query}`).set(auth);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.details.some((d: { path: string }) => d.path === path)).toBe(true);
  });
});

describe("read, update, delete", () => {
  beforeEach(async () => {
    await api()
      .post(BASE)
      .set(auth)
      .send({ name: "company_name", definition: { source: "field", field: "company_name" } });
    await api()
      .post(BASE)
      .set(auth)
      .send({ name: "season_label", definition: { source: "constant", value: "Winter Sale 2026" }, enabled: false });
  });

  it("lists every variable on one default page", async () => {
    const res = await api().get(BASE).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.variables).toHaveLength(2);
    expect(res.body.meta).toEqual({
      page: 1,
      limit: 25,
      total: 2,
      total_pages: 1,
      from: 1,
      to: 2,
      has_previous_page: false,
      has_next_page: false,
    });
  });

  it("filters by source, status and name", async () => {
    expect((await api().get(`${BASE}?source=constant`).set(auth)).body.meta.total).toBe(1);
    expect((await api().get(`${BASE}?enabled=false`).set(auth)).body.meta.total).toBe(1);
    expect((await api().get(`${BASE}?q=COMPANY`).set(auth)).body.meta.total).toBe(1);
  });

  it("rejects an unknown filter value", async () => {
    const res = await api().get(`${BASE}?source=nonsense`).set(auth);
    expect(res.status).toBe(400);
  });

  it("reads a single variable", async () => {
    const res = await api().get(`${BASE}/season_label`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.variable.definition).toEqual({ source: "constant", value: "Winter Sale 2026" });
    expect(res.body.variable.enabled).toBe(false);
  });

  it("404s on an unknown name", async () => {
    const res = await api().get(`${BASE}/nope`).set(auth);
    expect(res.status).toBe(404);
  });

  it("toggles status without touching the definition", async () => {
    const res = await api().patch(`${BASE}/season_label`).set(auth).send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.variable.enabled).toBe(true);
    expect(res.body.variable.definition).toEqual({ source: "constant", value: "Winter Sale 2026" });
  });

  it("replaces the definition whole, clearing the previous source's columns", async () => {
    const res = await api()
      .patch(`${BASE}/company_name`)
      .set(auth)
      .send({ definition: { source: "constant", value: "Acme" } });

    expect(res.status).toBe(200);
    expect(res.body.variable.definition).toEqual({ source: "constant", value: "Acme" });

    const stored = (await listVariables()).find((row) => row.name === "company_name");
    expect(stored?.field).toBeNull();
  });

  it("renames, and refuses a rename onto an existing name", async () => {
    const ok = await api().patch(`${BASE}/company_name`).set(auth).send({ name: "account_name" });
    expect(ok.status).toBe(200);
    expect(ok.body.variable.name).toBe("account_name");

    const clash = await api().patch(`${BASE}/account_name`).set(auth).send({ name: "season_label" });
    expect(clash.status).toBe(409);
  });

  it("deletes, and 404s on a second delete", async () => {
    expect((await api().delete(`${BASE}/season_label`).set(auth)).status).toBe(200);
    expect((await api().delete(`${BASE}/season_label`).set(auth)).status).toBe(404);
  });
});
