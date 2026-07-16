import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDispatcherDb, resetDbForTests, type DispatcherDb } from "./client.js";
import { resolveMigrationsDir, runDispatcherMigrations } from "./migrate.js";

type SqliteDb = Extract<DispatcherDb, { dialect: "sqlite" }>;

let dbx: SqliteDb | null = null;

afterEach(() => {
  dbx?.sqlite.close();
  dbx = null;
  resetDbForTests();
});

describe("runDispatcherMigrations (sqlite)", () => {
  it("creates all state tables", async () => {
    dbx = createDispatcherDb({ dialect: "sqlite", file: ":memory:" });
    await runDispatcherMigrations(dbx);
    const rows = dbx.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    for (const expected of [
      "variables",
      "dispatch_runs",
      "dispatch_recipient_failures",
      "webhook_activity",
      "campaign_callbacks",
      "campaign_events",
      "event_outbox",
      "app_logs",
      "dev_sent_campaigns",
      "dispatcher_meta",
      "user",
      "session",
      "account",
      "verification",
      "organization",
      "member",
      "invitation",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("is idempotent on a second run", async () => {
    dbx = createDispatcherDb({ dialect: "sqlite", file: ":memory:" });
    await runDispatcherMigrations(dbx);
    await expect(runDispatcherMigrations(dbx)).resolves.toBeUndefined();
  });
});

describe("migration folders", () => {
  it("resolves a directory per dialect", () => {
    for (const dialect of ["sqlite", "mysql", "postgres"] as const) {
      expect(resolveMigrationsDir(dialect)).toMatch(/drizzle/);
    }
  });

  it("all three dialects have the same number of migrations (drift guard)", () => {
    const counts = (["sqlite", "mysql", "postgres"] as const).map((dialect) => {
      const journal = JSON.parse(
        readFileSync(join(resolveMigrationsDir(dialect), "meta", "_journal.json"), "utf8")
      ) as { entries: unknown[] };
      return journal.entries.length;
    });
    expect(new Set(counts).size).toBe(1);
  });
});
