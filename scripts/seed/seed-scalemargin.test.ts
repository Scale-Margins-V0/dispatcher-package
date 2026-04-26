import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runScaleMarginSeed } from "./seed-scalemargin";

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("seed-scalemargin", () => {
  it("is idempotent and does not duplicate rows", () => {
    tempDir = mkdtempSync(join(tmpdir(), "scalemargin-seed-"));
    const dbFile = join(tempDir, "dispatch.sqlite");
    runScaleMarginSeed(dbFile);
    runScaleMarginSeed(dbFile);

    const db = new Database(dbFile, { readonly: true });
    try {
      const row = db
        .prepare("SELECT COUNT(*) as cnt FROM users WHERE user_id = ?")
        .get("test-user-001") as { cnt: number };
      expect(row.cnt).toBe(1);
    } finally {
      db.close();
    }
  });
});
