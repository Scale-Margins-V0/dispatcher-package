/**
 * The Atlas credential is a single environment variable, not a database row:
 * one deployment, one key, set by whoever deploys the dispatcher.
 *
 *     DISPATCHER_ATLAS_KEY=<random, 32+ chars>
 *
 * Consequences worth knowing:
 *   - Rotating or revoking means editing the environment and restarting. There
 *     is no runtime kill switch, unlike the console-managed keys used by /logs.
 *   - Unset means the Atlas API is OFF and every data-plane route fails closed.
 *     It never falls open.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export const ATLAS_KEY_ENV = "DISPATCHER_ATLAS_KEY";

/** Short enough to be a typo, long enough to brute force — warn below this. */
const MIN_KEY_LENGTH = 32;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function atlasKey(): string | null {
  const value = process.env[ATLAS_KEY_ENV]?.trim();
  return value ? value : null;
}

export function isAtlasApiConfigured(): boolean {
  return atlasKey() !== null;
}

/**
 * Constant-time comparison over fixed-length digests, so neither the key's
 * length nor its prefix leaks through response timing.
 */
export function verifyAtlasKey(presented: string): boolean {
  const expected = atlasKey();
  if (!expected || !presented) return false;
  return timingSafeEqual(sha256(presented), sha256(expected));
}

/**
 * Boot-time report. Returns a warning string when the configuration is present
 * but weak, so startup can say so once instead of silently accepting it.
 */
export function atlasKeyWarning(): string | null {
  const key = atlasKey();
  if (!key) {
    return `${ATLAS_KEY_ENV} is not set — the Atlas API (/api/v1/data-plane/*) is disabled.`;
  }
  if (key.length < MIN_KEY_LENGTH) {
    return `${ATLAS_KEY_ENV} is only ${key.length} characters — use at least ${MIN_KEY_LENGTH} (openssl rand -base64 32).`;
  }
  return null;
}
