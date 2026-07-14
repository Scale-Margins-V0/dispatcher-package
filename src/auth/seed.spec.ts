import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherDb } from "../db/client.js";
import { queryDb, tableFor } from "../db/dialect-helpers.js";
import { createTestDb, destroyTestDb } from "../db/test-utils.js";
import { generateStrongPassword, seedDefaultAdmin } from "./seed.js";
import { setupAuthForTest, teardownAuthForTest } from "./test-utils.js";

let dbx: DispatcherDb;
let workDir: string;
let credFile: string;

const countRows = async (table: "user" | "organization") => {
  const rows: unknown[] = await queryDb(dbx)
    .select({ id: tableFor(dbx, table).id })
    .from(tableFor(dbx, table));
  return rows.length;
};

beforeEach(async () => {
  dbx = await createTestDb();
  setupAuthForTest();
  workDir = mkdtempSync(join(tmpdir(), "dispatcher-seed-"));
  credFile = join(workDir, "creds.txt");
  process.env.DISPATCHER_ADMIN_CREDENTIALS_FILE = credFile;
  delete process.env.DISPATCHER_ADMIN_EMAIL;
  delete process.env.DISPATCHER_ADMIN_PASSWORD;
});

afterEach(() => {
  teardownAuthForTest();
  destroyTestDb(dbx);
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.DISPATCHER_ADMIN_EMAIL;
  delete process.env.DISPATCHER_ADMIN_PASSWORD;
  delete process.env.DISPATCHER_ADMIN_CREDENTIALS_FILE;
});

describe("generateStrongPassword", () => {
  it("produces a long, unique password each call", () => {
    const a = generateStrongPassword();
    const b = generateStrongPassword();
    expect(a.length).toBeGreaterThanOrEqual(20);
    expect(a).not.toBe(b);
  });
});

describe("seedDefaultAdmin", () => {
  it("seeds one owner + organization and is idempotent", async () => {
    await seedDefaultAdmin();
    expect(await countRows("user")).toBe(1);
    expect(await countRows("organization")).toBe(1);

    await seedDefaultAdmin();
    expect(await countRows("user")).toBe(1);
    expect(await countRows("organization")).toBe(1);
  });

  it("generates a password and reveals it once via a 0600 file", async () => {
    await seedDefaultAdmin();
    expect(existsSync(credFile)).toBe(true);
    const contents = readFileSync(credFile, "utf8");
    expect(contents).toMatch(/email: admin@scalemargins\.tech/);
    expect(contents).toMatch(/password: \S+/);
    // 0600 permissions (owner rw only)
    expect(statSync(credFile).mode & 0o777).toBe(0o600);
  });

  it("uses an env-provided password and never writes it to the credentials file", async () => {
    process.env.DISPATCHER_ADMIN_EMAIL = "owner@example.com";
    process.env.DISPATCHER_ADMIN_PASSWORD = "env-provided-password-123";
    await seedDefaultAdmin();
    expect(await countRows("user")).toBe(1);
    // env-provided password path does not write the reveal file
    expect(existsSync(credFile)).toBe(false);
  });
});
