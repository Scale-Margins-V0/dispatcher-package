import { lookupUsers, type UserRecord } from "../user-lookup.js";
import type { LookupChannel } from "../user-lookup/channel.js";
import { getDispatchConfig } from "../user-lookup/config.js";
import { recordMetric, type MetricScope } from "./collector.js";

/** "database" / "network" / "mock" — the operator's words for the lookup mode. */
function lookupMode(): string {
  const lookup = getDispatchConfig().user_lookup;
  if (lookup.backend === "mock") return "mock";
  if (lookup.backend === "http") return lookup.network ? "network" : "http";
  return "database";
}

/** lookupUsers, timed into the `lookup` metric. Rethrows — the caller decides. */
export async function timedLookupUsers(
  scope: MetricScope,
  userIds: string[],
  channel: LookupChannel
): Promise<Map<string, UserRecord>> {
  const started = performance.now();
  try {
    const users = await lookupUsers(userIds, channel);
    recordMetric(scope, "lookup", lookupMode(), {
      ok: 1,
      items: userIds.length,
      skipped: Math.max(0, userIds.length - users.size),
      ms: performance.now() - started,
    });
    return users;
  } catch (error) {
    recordMetric(scope, "lookup", lookupMode(), {
      failed: 1,
      items: userIds.length,
      ms: performance.now() - started,
    });
    throw error;
  }
}
