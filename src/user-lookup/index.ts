/**
 * Adapter factory + `lookupUsers` facade: one singleton per process, rebuilt after config reload.
 */

import type { DispatchConfig } from "./config.js";
import {
  getDispatchConfig,
  loadDispatchConfigFromDisk,
  resetDispatchConfigForTests,
} from "./config.js";
import { HttpAdapter } from "./adapters/http.js";
import { MockAdapter } from "./adapters/mock.js";
import { SqlAdapter } from "./adapters/sql.js";
import type { UserLookupAdapter, UserRecord } from "./types.js";

export type { UserRecord, UserLookupAdapter } from "./types.js";
export {
  resetDispatchConfigForTests,
  reloadDispatchConfigForTests,
  getDispatchConfig,
  ensureDispatchConfigLoaded,
} from "./config.js";

let adapter: UserLookupAdapter | null = null;

function createAdapter(cfg: DispatchConfig): UserLookupAdapter {
  switch (cfg.user_lookup.backend) {
    case "mock":
      return new MockAdapter();
    case "mysql":
    case "postgres":
    case "sqlite":
      return new SqlAdapter(cfg);
    case "http":
      return new HttpAdapter(cfg);
    default: {
      const x: never = cfg.user_lookup.backend;
      throw new Error(`Unknown backend: ${String(x)}`);
    }
  }
}

export function getLookupAdapter(): UserLookupAdapter {
  if (!adapter) {
    adapter = createAdapter(getDispatchConfig());
  }
  return adapter;
}

/** Reset singleton adapter (tests / hot reload). */
export function resetLookupAdapterForTests(): void {
  adapter = null;
}

/**
 * Reload config from disk and rebuild adapter (e.g. after env change in tests).
 */
export function reloadLookupAdapter(): UserLookupAdapter {
  resetLookupAdapterForTests();
  resetDispatchConfigForTests();
  loadDispatchConfigFromDisk();
  return getLookupAdapter();
}

export async function lookupUsers(
  userIds: string[]
): Promise<Map<string, UserRecord>> {
  return getLookupAdapter().lookupUsers(userIds);
}
