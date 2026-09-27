/**
 * dispatcher.retention.freshchat_status_poll_ttl — how long after a message was sent the
 * Freshchat status poller keeps asking about it. A message that never reaches a
 * final status (READ / FAILED) stops being polled once it is this old.
 *
 * Default "3d". Never longer than message_id_ttl: the row is pruned then, so a
 * longer window would promise polling that cannot happen.
 */

import { formatDuration, parseDuration } from "./duration.js";
import { messageIdTtlMs } from "./message-id-ttl.js";

export const STATUS_POLL_TTL_SETTING = "DISPATCHER_FRESHCHAT_STATUS_POLL_TTL";
const DISPLAY_NAME = `dispatcher.retention.freshchat_status_poll_ttl (${STATUS_POLL_TTL_SETTING})`;
const DEFAULT = "3d";

export type StatusPollTtl = { ms: number; cappedFrom?: number };

/** Parsed and capped. Throws with the setting's name when the value is unparseable. */
export function statusPollTtl(): StatusPollTtl {
  const raw = process.env[STATUS_POLL_TTL_SETTING]?.trim() || DEFAULT;
  const requested = parseDuration(raw, DISPLAY_NAME);
  let cap: number;
  try {
    cap = messageIdTtlMs();
  } catch {
    return { ms: requested }; // message_id_ttl is validated (and fatal) elsewhere
  }
  return requested > cap ? { ms: cap, cappedFrom: requested } : { ms: requested };
}

/** "3d", "capped to 5d 2h (message_id_ttl)" — for the boot log. */
export function describeStatusPollTtl(ttl: StatusPollTtl): string {
  return ttl.cappedFrom === undefined
    ? formatDuration(ttl.ms)
    : `${formatDuration(ttl.ms)} (freshchat_status_poll_ttl ${formatDuration(ttl.cappedFrom)} is longer than message_id_ttl — capped)`;
}
