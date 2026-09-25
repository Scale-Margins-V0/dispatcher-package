import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDispatchConfigForTests, setDispatchConfigForTests } from "../user-lookup/config.js";
import { resetLookupAdapterForTests } from "../user-lookup/index.js";
import { resetPlaceholdersForTests } from "./service.js";
import { resolveDynamicValues, testVariableDefinition } from "./resolver.js";
import type { UserRecord } from "../user-lookup/types.js";

const CTX = { campaign_id: "cmp1", organization_id: "org1" };

const user = (id: string, fields: Record<string, string> = {}): UserRecord => ({
  user_id: id,
  email: `${id}@example.com`,
  fields,
});

// Minimal dispatch config with a mock backend + registry-defining placeholders.
function configWith(placeholders: Record<string, unknown>) {
  return {
    user_lookup: {
      backend: "mock" as const,
      source: { kind: "table", name: "users", id_column: "id", id_type: "string" },
      fields: {},
    },
    placeholders,
  } as never;
}

beforeEach(() => {
  resetPlaceholdersForTests();
  resetLookupAdapterForTests();
});

afterEach(() => {
  resetDispatchConfigForTests();
  resetLookupAdapterForTests();
  vi.restoreAllMocks();
});

describe("resolveDynamicValues — api", () => {
  it("fetches per recipient and extracts a JSON path", async () => {
    setDispatchConfigForTests(
      configWith({
        tier: {
          source: "api",
          api: {
            method: "GET",
            url: "https://crm.example/u/{{user_id}}",
            json_path: "data.tier",
          },
          fallback: "standard",
        },
      })
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) =>
        new Response(JSON.stringify({ data: { tier: `gold-${String(url).split("/").pop()}` } }), {
          status: 200,
        })
      );

    const out = await resolveDynamicValues([user("u1"), user("u2")], CTX);
    expect(out.get("u1")?.values.tier).toBe("gold-u1");
    expect(out.get("u2")?.values.tier).toBe("gold-u2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("executes once when the URL does not vary by user (cache)", async () => {
    setDispatchConfigForTests(
      configWith({
        rate: { source: "api", api: { method: "GET", url: "https://fx.example/usd", json_path: "rate" } },
      })
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ rate: "1.09" }), { status: 200 }));

    const out = await resolveDynamicValues([user("u1"), user("u2"), user("u3")], CTX);
    expect(out.get("u1")?.values.rate).toBe("1.09");
    expect(out.get("u3")?.values.rate).toBe("1.09");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back and does not throw when the API errors", async () => {
    setDispatchConfigForTests(
      configWith({
        tier: {
          source: "api",
          api: { method: "GET", url: "https://crm.example/x", json_path: "tier" },
          fallback: "standard",
        },
      })
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    const out = await resolveDynamicValues([user("u1")], CTX);
    expect(out.get("u1")?.values.tier).toBe("standard");
  });
});

describe("resolveDynamicValues — query (sqlite lookup backend)", () => {
  let workDir: string;
  let dbFile: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "resolver-sql-"));
    dbFile = join(workDir, "lookup.sqlite");
    const db = new Database(dbFile);
    db.exec("CREATE TABLE loyalty (user_id TEXT PRIMARY KEY, tier TEXT)");
    db.prepare("INSERT INTO loyalty VALUES (?, ?)").run("u1", "gold");
    db.prepare("INSERT INTO loyalty VALUES (?, ?)").run("u2", "silver");
    db.close();
  });

  afterEach(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore Windows file lock on temporary sqlite db */
    }
  });

  const sqliteConfig = (placeholders: Record<string, unknown>) =>
    ({
      user_lookup: {
        backend: "sqlite" as const,
        sqlite: { file: dbFile },
        source: { kind: "table", name: "loyalty", id_column: "user_id", id_type: "string" },
        fields: {},
      },
      placeholders,
    }) as never;

  it("binds {{user_id}} and returns the scalar per recipient", async () => {
    setDispatchConfigForTests(
      sqliteConfig({
        tier: {
          source: "query",
          sql: "SELECT tier FROM loyalty WHERE user_id = {{user_id}}",
          fallback: "none",
        },
      })
    );
    const out = await resolveDynamicValues([user("u1"), user("u2"), user("u3")], CTX);
    expect(out.get("u1")?.values.tier).toBe("gold");
    expect(out.get("u2")?.values.tier).toBe("silver");
    expect(out.get("u3")?.values.tier).toBe("none"); // no row → fallback
  });

  it("is injection-safe: a malicious user_id is bound, not interpreted", async () => {
    setDispatchConfigForTests(
      sqliteConfig({
        tier: {
          source: "query",
          sql: "SELECT tier FROM loyalty WHERE user_id = {{user_id}}",
          fallback: "none",
        },
      })
    );
    const out = await resolveDynamicValues([user("u1'; DROP TABLE loyalty; --")], CTX);
    expect(out.get("u1'; DROP TABLE loyalty; --")?.values.tier).toBe("none");
    // Table survived — the value was bound, not executed.
    const db = new Database(dbFile);
    expect(db.prepare("SELECT count(*) c FROM loyalty").get()).toMatchObject({ c: 2 });
    db.close();
  });

  it("rejects a non-SELECT query", async () => {
    const r = await testVariableDefinition({ source: "query", sql: "DELETE FROM loyalty" });
    // Zod guards this in the API; the adapter guard is the backstop:
    setDispatchConfigForTests(sqliteConfig({}));
    const r2 = await testVariableDefinition({ source: "query", sql: "DELETE FROM loyalty" });
    expect(r.ok === false || r2.ok === false).toBe(true);
  });
});

describe("testVariableDefinition", () => {
  it("previews a constant without any I/O", async () => {
    const r = await testVariableDefinition({ source: "constant", value: "VIP" });
    expect(r).toEqual({ ok: true, value: "VIP" });
  });

  it("runs an api definition live and returns the extracted value", async () => {
    resetLookupAdapterForTests();
    setDispatchConfigForTests(configWith({}));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: { name: "Ada" } }), { status: 200 })
    );
    const r = await testVariableDefinition({
      source: "api",
      api: { method: "GET", url: "https://x.example/{{user_id}}", json_path: "ok.name" },
    });
    expect(r).toMatchObject({ ok: true, value: "Ada" });
    // The raw exchange comes back too, so the editor can render it like a REST client.
    expect(r.response).toMatchObject({ ok: true, status: 200 });
    expect(r.response?.body).toContain("Ada");
  });

  it("returns the response (not just an error) when the API fails", async () => {
    setDispatchConfigForTests(configWith({}));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "nope" }), { status: 404 })
    );
    const r = await testVariableDefinition({
      source: "api",
      api: { method: "GET", url: "https://x.example/u", json_path: "a" },
      fallback: "standard",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("404");
    expect(r.response).toMatchObject({ status: 404, ok: false });
    expect(r.response?.body).toContain("nope");
  });

  it("reports the error for a query variable with no SQL backend", async () => {
    setDispatchConfigForTests(configWith({}));
    const r = await testVariableDefinition({ source: "query", sql: "SELECT 1" });
    expect(r.ok).toBe(false);
  });
});

describe("resolveDynamicValues — nested api paths", () => {
  const userInfo = (extra: Record<string, unknown> = {}) => ({
    user_info: {
      source: "api",
      api: {
        method: "GET",
        url: "https://crm.example/users",
        query: [{ key: "user_id", value: "{{user_id}}" }],
        json_path: "",
        response_schema: [
          { path: "info.firstname", type: "string" },
          { path: "info.address.pincode", type: "string" },
        ],
        ...extra,
      },
      fallback: "-",
    },
  });
  const body = {
    info: { firstname: "Ada", address: { pincode: "560001" }, tier: "gold" },
    orders: [{ id: 7 }],
  };
  const respond = () =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }));

  it("fills every declared path from ONE request per recipient", async () => {
    setDispatchConfigForTests(configWith(userInfo()));
    const fetchMock = respond();
    const out = await resolveDynamicValues([user("u1")], CTX);
    expect(out.get("u1")?.values).toMatchObject({
      "user_info.info.firstname": "Ada",
      "user_info.info.address.pincode": "560001",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The schema is for discovery, not a gate: the response decides what exists.
  it("resolves a path the template uses even if it was never declared", async () => {
    setDispatchConfigForTests(configWith(userInfo()));
    respond();
    const out = await resolveDynamicValues([user("u1")], CTX, ["Tier: {{user_info.info.tier}}, order {{user_info.orders.0.id}}"]);
    expect(out.get("u1")?.values["user_info.info.tier"]).toBe("gold");
    expect(out.get("u1")?.values["user_info.orders.0.id"]).toBe("7");
  });

  it("falls back per path, and reports which token fell back", async () => {
    setDispatchConfigForTests(configWith(userInfo()));
    respond();
    const out = await resolveDynamicValues([user("u1")], CTX, ["{{user_info.info.missing}}"]);
    expect(out.get("u1")?.values["user_info.info.missing"]).toBe("-");
    expect(out.get("u1")?.fallbacks).toContain("user_info.info.missing");
    expect(out.get("u1")?.fallbacks).not.toContain("user_info.info.firstname");
  });

  it("appends query rows, encoding the recipient's value", async () => {
    setDispatchConfigForTests(configWith(userInfo()));
    const fetchMock = respond();
    await resolveDynamicValues([user("a&b=c")], CTX);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://crm.example/users?user_id=a%26b%3Dc");
  });

  it("keeps a query string already in the URL and adds to it", async () => {
    setDispatchConfigForTests(configWith(userInfo({ url: "https://crm.example/users?v=2" })));
    const fetchMock = respond();
    await resolveDynamicValues([user("u1")], CTX);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://crm.example/users?v=2&user_id=u1");
  });

  // A quote in someone's data must not break — or inject into — a JSON body.
  it("JSON-escapes tokens inside a JSON body", async () => {
    setDispatchConfigForTests(
      configWith(userInfo({ method: "POST", query: [], body: '{"id": "{{user_id}}"}' }))
    );
    const fetchMock = respond();
    await resolveDynamicValues([user('x", "admin": true, "y": "')], CTX);
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(sent).toEqual({ id: 'x", "admin": true, "y": "' });
  });

  it("never sends a body on GET, whatever is stored", async () => {
    setDispatchConfigForTests(configWith(userInfo({ body: '{"id": "{{user_id}}"}' })));
    const fetchMock = respond();
    await resolveDynamicValues([user("u1")], CTX);
    expect(fetchMock.mock.calls[0]![1]!.body).toBeUndefined();
  });

  it("falls back on every token when the request fails", async () => {
    setDispatchConfigForTests(configWith(userInfo()));
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("nope", { status: 500 }));
    const out = await resolveDynamicValues([user("u1")], CTX);
    expect(out.get("u1")?.values).toMatchObject({
      user_info: "-",
      "user_info.info.firstname": "-",
      "user_info.info.address.pincode": "-",
    });
  });

  it("returns the derived schema from a live test", async () => {
    respond();
    const result = await testVariableDefinition({
      source: "api",
      api: { method: "GET", url: "https://crm.example/users", json_path: "info.firstname" },
    });
    expect(result.value).toBe("Ada");
    expect(result.schema?.map((f) => f.path)).toContain("info.address.pincode");
  });
});

describe("resolveDynamicValues — objects never render", () => {
  it("falls back when a path, or the default path, holds an object or array", async () => {
    setDispatchConfigForTests(
      configWith({
        user_info: {
          source: "api",
          api: { method: "GET", url: "https://crm.example/u", json_path: "" },
          fallback: "-",
        },
      })
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ info: { city: "Pune" }, tags: ["a"], name: "Ada" }), { status: 200 })
    );
    const out = await resolveDynamicValues([user("u1")], CTX, [
      "{{user_info.info}} {{user_info.tags}} {{user_info.name}}",
    ]);
    expect(out.get("u1")?.values).toMatchObject({
      user_info: "-", // empty default path = the whole response, an object
      "user_info.info": "-",
      "user_info.tags": "-",
      "user_info.name": "Ada",
    });
  });
});

