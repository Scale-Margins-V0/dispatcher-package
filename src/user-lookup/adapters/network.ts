/**
 * Network lookup: ask the client's API who these opaque ids are.
 *
 * The contract is fixed — one URL, one bearer token, one request shape — unlike
 * the `http` backend it replaces, where every path and field name was
 * configurable. A published contract is something a client can implement once;
 * a configurable one is something we have to explain every time.
 *
 *   POST <url>   { "user_ids": [...], "channel": "email", "fields": [...] }
 *   200          { "users": [{ "user_id": "u1", ... }] }
 *
 * `fields` are the CLIENT's names — the values of the `fields:` map — and the
 * response is read back by the same names. Only the channel's own contact field
 * is asked for (see channel.ts): an email lookup never asks for a phone number.
 *
 * Ids are compared **as strings**, with no type coercion. A JSON number is
 * accepted (`42` matches the id `"42"` we sent) because that is a serializer
 * quirk rather than a different user, and stringifying cannot drop anyone. The
 * int/bigint/uuid coercion the SQL path needs is deliberately absent: it fails
 * closed on a bad value, which is how a recipient disappears with only a
 * warning.
 */

import { z } from "zod";
import { componentLogger } from "../../logging/logger.js";
import type { DispatchConfig } from "../config.js";
import { chunkArray, stringFromCell } from "../mapper.js";
import { fieldsForChannel, isReachable, type LookupChannel } from "../channel.js";
import type { UserLookupAdapter, UserRecord } from "../types.js";

const log = componentLogger("user-lookup.network");

/** Unknown keys are ignored rather than rejected: their API may serve others. */
const responseSchema = z.object({
  users: z.array(z.record(z.string(), z.unknown())).default([]),
});

type NetworkConfig = NonNullable<DispatchConfig["user_lookup"]["network"]>;

const RETRY_BASE_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Inline token wins over `token_env`, matching the sender convention. */
function bearerToken(cfg: NetworkConfig): string | undefined {
  return cfg.token ?? (cfg.token_env ? process.env[cfg.token_env] : undefined);
}

/** A 4xx is a bug in the request or the credential — retrying cannot fix it. */
function isRetryable(status: number): boolean {
  return status >= 500;
}

/** Preserves first-seen order so a partial response is easy to read in a log. */
function uniqueIds(userIds: string[], dedupe: boolean): string[] {
  return dedupe ? [...new Set(userIds)] : userIds;
}

export class NetworkAdapter implements UserLookupAdapter {
  constructor(private readonly cfg: DispatchConfig) {}

  async lookupUsers(
    userIds: string[],
    channel: LookupChannel = "email"
  ): Promise<Map<string, UserRecord>> {
    const out = new Map<string, UserRecord>();
    if (userIds.length === 0) return out;

    const lookup = this.cfg.user_lookup;
    const network = lookup.network;
    if (!network) throw new Error("user_lookup.network is required for network mode");

    const fieldMap = fieldsForChannel(lookup.fields, channel);
    // Their names, not ours: the response is read by these same names, so
    // asking with the logical keys resolved nothing for `phone: phone_no`.
    const requested = [...new Set(Object.values(fieldMap))];
    const ids = uniqueIds(userIds, lookup.batch?.dedupe !== false);
    const chunkSize = lookup.batch?.max_ids_per_query ?? 1000;

    for (const chunk of chunkArray(ids, chunkSize)) {
      const records = await this.fetchChunk(network, chunk, channel, requested);
      for (const record of records) {
        const user = toUserRecord(record, fieldMap, channel);
        // A record for an id we never asked about is not ours to trust.
        if (user && chunk.includes(user.user_id)) out.set(user.user_id, user);
      }
    }

    log.info(
      { channel, requested: userIds.length, resolved: out.size },
      "Network lookup complete"
    );
    return out;
  }

  /** One chunk. A failure here costs those recipients, never the whole run. */
  private async fetchChunk(
    network: NetworkConfig,
    userIds: string[],
    channel: LookupChannel,
    fields: string[]
  ): Promise<Record<string, unknown>[]> {
    const token = bearerToken(network);
    const attempts = network.retries + 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), network.timeout_ms);
      try {
        const res = await fetch(network.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ user_ids: userIds, channel, fields }),
          signal: controller.signal,
        });

        if (!res.ok) {
          if (isRetryable(res.status) && attempt < attempts - 1) {
            await sleep(RETRY_BASE_MS * 2 ** attempt);
            continue;
          }
          log.warn(
            { status: res.status, count: userIds.length, error_category: "lookup_failed" },
            `Lookup chunk failed with HTTP ${res.status}`
          );
          return [];
        }

        return responseSchema.parse(await res.json()).users;
      } catch (error) {
        if (attempt < attempts - 1) {
          await sleep(RETRY_BASE_MS * 2 ** attempt);
          continue;
        }
        log.warn(
          {
            count: userIds.length,
            error_category: "lookup_failed",
            err: error instanceof Error ? error : new Error(String(error)),
          },
          "Lookup chunk failed"
        );
        return [];
      } finally {
        clearTimeout(timer);
      }
    }
    return [];
  }
}

/**
 * One response record → a `UserRecord`, or null when it cannot address anyone.
 *
 * The channel's contact field is required here exactly as it is for the SQL
 * backends, so all modes drop the same records rather than each having its own
 * rule.
 */
function toUserRecord(
  record: Record<string, unknown>,
  fieldMap: Record<string, string>,
  channel: LookupChannel
): UserRecord | null {
  const userId = stringFromCell(record.user_id);
  if (!userId) return null;

  const fields: Record<string, string | undefined> = {};
  for (const [logical, remote] of Object.entries(fieldMap)) {
    fields[logical] = stringFromCell(record[remote]);
  }

  if (!isReachable(fields, channel)) return null;

  return { user_id: userId, email: fields.email ?? "", fields };
}
