/**
 * The Atlas credential is a single deployment-wide setting, not a database row:
 * one deployment, one key, set by whoever deploys the dispatcher. Either
 *
 *     dispatcher: { atlas_key: … }   in .env.yaml     (preferred)
 *     DISPATCHER_ATLAS_KEY=…         in the environment
 *
 * Consequences worth knowing:
 *   - Rotating or revoking means editing the configuration and restarting.
 *     There is no runtime kill switch, unlike the console-managed keys used by
 *     /logs.
 *   - Unset in BOTH places means the Atlas API is OFF and every data-plane
 *     route fails closed. It never falls open.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { danglingAtlasKeyRef, resolveAtlasKey, settingName } from "../../dispatcher-settings.js";

export const ATLAS_KEY_ENV = "DISPATCHER_ATLAS_KEY";

/** Short enough to be a typo, long enough to brute force — warn below this. */
const MIN_KEY_LENGTH = 32;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function atlasKey(): string | null {
  return resolveAtlasKey()?.value ?? null;
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
  // A reference to a variable that does not exist is reported even when a key
  // was found elsewhere: the operator wrote it expecting it to be used, and
  // silently falling back to a different credential is how the wrong key ends
  // up in production.
  const dangling = danglingAtlasKeyRef();

  const resolved = resolveAtlasKey();
  if (!resolved) {
    return dangling
      ? `dispatcher.atlas_key_env names "${dangling}", which is not set, and ${ATLAS_KEY_ENV} is not set either — the Atlas API (/api/v1/data-plane/*) is disabled.`
      : `No Atlas key configured (dispatcher.atlas_key in .env.yaml, or ${ATLAS_KEY_ENV}) — the Atlas API (/api/v1/data-plane/*) is disabled.`;
  }

  const name = settingName("atlas_key", resolved.source);
  if (dangling) {
    return `dispatcher.atlas_key_env names "${dangling}", which is not set — falling back to ${name}.`;
  }
  if (resolved.value.length < MIN_KEY_LENGTH) {
    return `${name} is only ${resolved.value.length} characters — use at least ${MIN_KEY_LENGTH} (openssl rand -base64 32).`;
  }
  return null;
}
