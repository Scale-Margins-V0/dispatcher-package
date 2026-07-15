/**
 * Bearer token for the public GET /logs API. The plaintext is shown to the
 * admin exactly once at generation; only its sha256 hash is persisted (in
 * dispatcher_meta). An env token (DISPATCHER_LOGS_API_TOKEN) overrides the DB.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getMeta, setMeta } from "../db/repos/meta.js";

const TOKEN_HASH_KEY = "logs_api_token_hash";
const TOKEN_UPDATED_KEY = "logs_api_token_updated_at";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Generate a new token, persist its hash, return the plaintext (once). */
export async function generateLogsToken(): Promise<string> {
  const token = `dlk_${randomBytes(24).toString("hex")}`;
  await setMeta(TOKEN_HASH_KEY, sha256Hex(token));
  await setMeta(TOKEN_UPDATED_KEY, new Date().toISOString());
  return token;
}

export async function getLogsTokenStatus(): Promise<{ configured: boolean; updated_at: string | null }> {
  const envToken = process.env.DISPATCHER_LOGS_API_TOKEN?.trim();
  if (envToken) return { configured: true, updated_at: null };
  const hash = await getMeta(TOKEN_HASH_KEY);
  const updated = await getMeta(TOKEN_UPDATED_KEY);
  return { configured: Boolean(hash), updated_at: updated };
}

/** Constant-time check of a presented bearer token against env or the stored hash. */
export async function verifyLogsToken(presented: string): Promise<boolean> {
  if (!presented) return false;
  const envToken = process.env.DISPATCHER_LOGS_API_TOKEN?.trim();
  if (envToken) return safeEqualHex(sha256Hex(presented), sha256Hex(envToken));
  const storedHash = await getMeta(TOKEN_HASH_KEY);
  if (!storedHash) return false;
  return safeEqualHex(sha256Hex(presented), storedHash);
}
