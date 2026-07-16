import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherDb } from "../db/client.js";
import { createTestDb, destroyTestDb } from "../db/test-utils.js";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  verifyApiKey,
} from "./api-keys.js";

let dbx: DispatcherDb;

beforeEach(async () => {
  process.env.BETTER_AUTH_SECRET = "test-api-key-encryption-secret-value";
  dbx = await createTestDb();
});

afterEach(() => {
  destroyTestDb(dbx);
  delete process.env.BETTER_AUTH_SECRET;
});

describe("named API keys", () => {
  it("creates encrypted, retrievable keys that authenticate", async () => {
    const created = await createApiKey("Reporting production");
    expect(created.key).toMatch(/^smk_/);
    expect(await verifyApiKey(created.key)).toBe(true);
    expect((await listApiKeys())[0]?.key).toBe(created.key);
    if (dbx.dialect === "sqlite") {
      const stored = dbx.sqlite.prepare("SELECT key_ciphertext FROM api_keys WHERE id = ?").get(created.id) as { key_ciphertext: string };
      expect(stored.key_ciphertext).not.toContain(created.key);
    }
  });

  it("rotates and revokes without affecting other named keys", async () => {
    const first = await createApiKey("Client one");
    const second = await createApiKey("Client two");
    const rotated = await rotateApiKey(first.id);
    expect(rotated?.key).not.toBe(first.key);
    expect(await verifyApiKey(first.key)).toBe(false);
    expect(await verifyApiKey(rotated!.key)).toBe(true);
    expect(await revokeApiKey(first.id)).toBe(true);
    expect(await verifyApiKey(rotated!.key)).toBe(false);
    expect(await verifyApiKey(second.key)).toBe(true);
  });
});
