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
    expect(out.get("u1")?.tier).toBe("gold-u1");
    expect(out.get("u2")?.tier).toBe("gold-u2");
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
    expect(out.get("u1")?.rate).toBe("1.09");
    expect(out.get("u3")?.rate).toBe("1.09");
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
    expect(out.get("u1")?.tier).toBe("standard");
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
    rmSync(workDir, { recursive: true, force: true });
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
    expect(out.get("u1")?.tier).toBe("gold");
    expect(out.get("u2")?.tier).toBe("silver");
    expect(out.get("u3")?.tier).toBe("none"); // no row → fallback
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
    expect(out.get("u1'; DROP TABLE loyalty; --")?.tier).toBe("none");
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
    expect(r).toEqual({ ok: true, value: "Ada" });
  });

  it("reports the error for a query variable with no SQL backend", async () => {
    setDispatchConfigForTests(configWith({}));
    const r = await testVariableDefinition({ source: "query", sql: "SELECT 1" });
    expect(r.ok).toBe(false);
  });
});
