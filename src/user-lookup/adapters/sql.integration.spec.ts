/**
 * `SqlAdapter` on a temp SQLite DB: `source.kind` **table** vs **view** (same SELECT shape).
 */
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDispatchConfig } from "../config.js";
import { SqlAdapter } from "./sql.js";

describe("SqlAdapter (sqlite, source.kind table)", () => {
  let dbPath: string;
  let adapter: SqlAdapter;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sql-adapt-"));
    dbPath = join(dir, "users.sqlite");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE users (
        user_id TEXT PRIMARY KEY,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        email TEXT NOT NULL,
        company_name TEXT,
        phone_no TEXT
      )
    `);
    const ins = db.prepare(
      `INSERT INTO users (user_id, first_name, last_name, email, company_name, phone_no)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    ins.run("u1", "नीरज", "Singh", "u1@example.com", "Acme", "+911");
    ins.run("u2", "Priya", "Sharma", "priya@example.com", "Tata Digital", "+922");
    ins.run("u3", "Rahul", "Patel", "rahul@example.com", null, null);
    db.close();

    const cfg = parseDispatchConfig({
      user_lookup: {
        backend: "sqlite",
        source: {
          kind: "table",
          name: "users",
          id_column: "user_id",
          id_type: "string",
        },
        sqlite: { file: dbPath },
        fields: {
          first_name: "first_name",
          last_name: "last_name",
          email: "email",
          company_name: "company_name",
          phone: "phone_no",
        },
      },
      placeholders: {
        email: { source: "field", field: "email" },
      },
    });
    adapter = new SqlAdapter(cfg);
  });

  afterAll(() => {
    try {
      unlinkSync(dbPath);
      rmSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  it("resolves existing users and skips missing", async () => {
    const m = await adapter.lookupUsers(["u1", "ghost"]);
    expect(m.size).toBe(1);
    const u = m.get("u1")!;
    expect(u.email).toBe("u1@example.com");
    expect(u.fields.first_name).toBe("नीरज");
    expect(u.user_id).toBe("u1");
  });

  it("batch lookup returns many rows in one query (order not guaranteed)", async () => {
    const m = await adapter.lookupUsers(["u3", "ghost", "u1", "u2"]);
    expect(m.size).toBe(3);
    expect(m.get("u1")?.email).toBe("u1@example.com");
    expect(m.get("u2")?.fields.company_name).toBe("Tata Digital");
    expect(m.get("u3")?.fields.last_name).toBe("Patel");
    expect(m.has("ghost")).toBe(false);
  });
});

describe("SqlAdapter (sqlite, source.kind view)", () => {
  let dbPath: string;
  let adapter: SqlAdapter;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sql-adapt-view-"));
    dbPath = join(dir, "users.sqlite");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE user_store (
        user_id TEXT PRIMARY KEY,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        email TEXT NOT NULL,
        company_name TEXT,
        phone_no TEXT
      );
      CREATE VIEW v_user_profiles AS
        SELECT user_id, first_name, last_name, email, company_name, phone_no
        FROM user_store;
    `);
    const ins = db.prepare(
      `INSERT INTO user_store (user_id, first_name, last_name, email, company_name, phone_no)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    ins.run("v-user-1", "View", "Row", "viewrow@example.com", "ViewCo", null);
    ins.run("v-user-2", "Second", "Person", "second@example.com", "Co2", "+200");
    ins.run("v-user-3", "Third", "Member", "third@example.com", null, null);
    db.close();

    const cfg = parseDispatchConfig({
      user_lookup: {
        backend: "sqlite",
        source: {
          kind: "view",
          name: "v_user_profiles",
          id_column: "user_id",
          id_type: "string",
        },
        sqlite: { file: dbPath },
        fields: {
          first_name: "first_name",
          last_name: "last_name",
          email: "email",
          company_name: "company_name",
          phone: "phone_no",
        },
      },
      placeholders: {
        email: { source: "field", field: "email" },
      },
    });
    adapter = new SqlAdapter(cfg);
  });

  afterAll(() => {
    try {
      unlinkSync(dbPath);
      rmSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  it("SELECTs through a view name the same as a table in generated SQL", async () => {
    const m = await adapter.lookupUsers(["v-user-1", "nope"]);
    expect(m.size).toBe(1);
    const u = m.get("v-user-1")!;
    expect(u.email).toBe("viewrow@example.com");
    expect(u.fields.first_name).toBe("View");
    expect(u.user_id).toBe("v-user-1");
  });

  it("batch lookup resolves multiple users through the view", async () => {
    const m = await adapter.lookupUsers(["v-user-2", "v-user-1", "missing", "v-user-3"]);
    expect(m.size).toBe(3);
    expect(m.get("v-user-2")?.email).toBe("second@example.com");
    expect(m.get("v-user-3")?.fields.first_name).toBe("Third");
  });
});
