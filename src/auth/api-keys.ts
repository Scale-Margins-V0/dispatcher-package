import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { queryDb, tableFor } from "../db/dialect-helpers.js";
import type { ApiKeyRow } from "../db/schema/index.js";
import { resolveAuthSecret } from "./secret.js";

const KEY_PREFIX = "smk_";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encryptionKey(): Buffer {
  const source = process.env.DISPATCHER_API_KEY_ENCRYPTION_SECRET?.trim() || resolveAuthSecret();
  return createHash("sha256").update(source).digest();
}

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decrypt(value: string): string {
  const [version, iv, tag, encrypted] = value.split(".");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("Unsupported API key ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function generatePlaintext(): string {
  return `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export type ApiKeyView = {
  id: string;
  name: string;
  key: string;
  prefix: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

function serialize(row: ApiKeyRow): ApiKeyView {
  return {
    id: row.id,
    name: row.name,
    key: decrypt(row.key_ciphertext),
    prefix: row.key_prefix,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    last_used_at: row.last_used_at?.toISOString() ?? null,
    revoked_at: row.revoked_at?.toISOString() ?? null,
  };
}

export async function listApiKeys(): Promise<ApiKeyView[]> {
  const dbx = getDb();
  const table = tableFor(dbx, "apiKeys");
  const rows: ApiKeyRow[] = await queryDb(dbx).select().from(table).orderBy(desc(table.created_at));
  return rows.map(serialize);
}

export async function createApiKey(name: string): Promise<ApiKeyView> {
  const dbx = getDb();
  const table = tableFor(dbx, "apiKeys");
  const existing: ApiKeyRow[] = await queryDb(dbx).select().from(table).where(eq(table.name, name));
  if (existing.length > 0) throw new Error("An API key with this name already exists");

  const key = generatePlaintext();
  const now = new Date();
  const row: ApiKeyRow = {
    id: crypto.randomUUID(),
    name,
    key_hash: sha256Hex(key),
    key_ciphertext: encrypt(key),
    key_prefix: key.slice(0, 12),
    created_at: now,
    updated_at: now,
    last_used_at: null,
    revoked_at: null,
  };
  await queryDb(dbx).insert(table).values(row);
  return serialize(row);
}

export async function rotateApiKey(id: string): Promise<ApiKeyView | null> {
  const dbx = getDb();
  const table = tableFor(dbx, "apiKeys");
  const rows: ApiKeyRow[] = await queryDb(dbx).select().from(table).where(eq(table.id, id));
  const current = rows[0];
  if (!current || current.revoked_at) return null;
  const key = generatePlaintext();
  const now = new Date();
  const keyHash = sha256Hex(key);
  const keyCiphertext = encrypt(key);
  await queryDb(dbx)
    .update(table)
    .set({
      key_hash: keyHash,
      key_ciphertext: keyCiphertext,
      key_prefix: key.slice(0, 12),
      updated_at: now,
      last_used_at: null,
    })
    .where(eq(table.id, id));
  return serialize({
    ...current,
    key_hash: keyHash,
    key_ciphertext: keyCiphertext,
    key_prefix: key.slice(0, 12),
    updated_at: now,
    last_used_at: null,
  });
}

export async function revokeApiKey(id: string): Promise<boolean> {
  const dbx = getDb();
  const table = tableFor(dbx, "apiKeys");
  const rows: ApiKeyRow[] = await queryDb(dbx).select().from(table).where(eq(table.id, id));
  if (!rows[0] || rows[0].revoked_at) return false;
  const now = new Date();
  await queryDb(dbx).update(table).set({ revoked_at: now, updated_at: now }).where(eq(table.id, id));
  return true;
}

export async function verifyApiKey(presented: string): Promise<boolean> {
  if (!presented.startsWith(KEY_PREFIX)) return false;
  const dbx = getDb();
  const table = tableFor(dbx, "apiKeys");
  const hash = sha256Hex(presented);
  const rows: ApiKeyRow[] = await queryDb(dbx)
    .select()
    .from(table)
    .where(and(eq(table.key_hash, hash), isNull(table.revoked_at)));
  const row = rows[0];
  if (!row) return false;
  const matches = timingSafeEqual(Buffer.from(hash), Buffer.from(row.key_hash));
  if (matches) {
    void queryDb(dbx)
      .update(table)
      .set({ last_used_at: new Date() })
      .where(eq(table.id, row.id))
      .catch(() => undefined);
  }
  return matches;
}

export function bearerFromRequest(header: string | undefined): string {
  return /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1]?.trim() ?? "";
}
