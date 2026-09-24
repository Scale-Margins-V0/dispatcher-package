/**
 * How long provider message ids are kept.
 *
 *     dispatcher:
 *       retention:
 *         message_id_ttl: "5d 2h"   # .env.yaml
 *     DISPATCHER_MESSAGE_ID_TTL=5d 2h
 *
 * **Mandatory, with no default.** Every other retention window here has one,
 * because guessing wrong costs some disk. This table is different: the ids are
 * only useful for as long as the operator intends to poll the provider with
 * them, and that is a decision about their data, not ours. A default would
 * silently be either too short (ids gone before they were used) or effectively
 * forever.
 *
 * Validated once at boot so a bad value stops the process there, rather than
 * surfacing an hour later inside a retention sweep that swallows its errors.
 */

import { parseDuration } from "./duration.js";

export const MESSAGE_ID_TTL_SETTING = "DISPATCHER_MESSAGE_ID_TTL";

/** Friendlier name in errors, since most operators set it in `.env.yaml`. */
const DISPLAY_NAME = `dispatcher.retention.message_id_ttl (${MESSAGE_ID_TTL_SETTING})`;

let cached: number | null = null;

/**
 * The window in milliseconds. Throws if unset or unparseable — call
 * `assertMessageIdTtlConfigured()` at boot so that never happens mid-sweep.
 */
export function messageIdTtlMs(): number {
  if (cached === null) {
    cached = parseDuration(process.env[MESSAGE_ID_TTL_SETTING], DISPLAY_NAME);
  }
  return cached;
}

/**
 * Boot gate. Returns the parsed window so the caller can log what it resolved
 * to; throws `DurationParseError` with an actionable message otherwise.
 */
export function assertMessageIdTtlConfigured(): number {
  return messageIdTtlMs();
}

export function resetMessageIdTtlForTests(): void {
  cached = null;
}
