/**
 * `.env.yaml` `user_lookup` → the `DispatchConfig` the rest of the app already
 * speaks.
 *
 * Keeping the internal shape unchanged is what makes this migration cheap:
 * `getDispatchConfig()` has 25 upstream callers across 9 execution flows, and
 * none of them need to know where the configuration came from. The public
 * vocabulary changes (`mode: network`); the internal enum does not.
 */

import type { DispatchConfig } from "./config.js";
import { DEFAULT_PLACEHOLDERS } from "./placeholders.js";
import type { UserLookupYaml } from "./schema.js";

/** `mode` is what an operator writes; `backend` is what the adapters switch on. */
const BACKEND_BY_MODE = {
  network: "http",
  mock: "mock",
} as const;

function backendFor(lookup: UserLookupYaml): DispatchConfig["user_lookup"]["backend"] {
  return lookup.mode === "database" ? lookup.backend : BACKEND_BY_MODE[lookup.mode];
}

/**
 * Mock takes no `fields`, but every adapter downstream expects the key to
 * exist. The defaults mirror what `dispatch.yaml`-less deployments have always
 * resolved against.
 */
const MOCK_FIELDS: Record<string, string> = {
  first_name: "first_name",
  last_name: "last_name",
  email: "email",
  phone: "phone",
  company_name: "company_name",
};

export function dispatchConfigFromEnvYaml(lookup: UserLookupYaml): DispatchConfig {
  const shared = {
    backend: backendFor(lookup),
    // Placeholders come from Postgres. These are only the seed for a brand-new
    // deployment and the fallback for processes that never init the DB.
    fields: lookup.mode === "mock" ? MOCK_FIELDS : lookup.fields,
    batch: lookup.mode === "mock" ? undefined : lookup.batch,
  };

  if (lookup.mode === "database") {
    return {
      user_lookup: {
        ...shared,
        source: lookup.source,
        connection: lookup.connection,
        ...(lookup.connection?.file ? { sqlite: { file: lookup.connection.file } } : {}),
      },
      placeholders: DEFAULT_PLACEHOLDERS,
    };
  }

  if (lookup.mode === "network") {
    return {
      user_lookup: { ...shared, network: lookup.network },
      placeholders: DEFAULT_PLACEHOLDERS,
    };
  }

  return { user_lookup: shared, placeholders: DEFAULT_PLACEHOLDERS };
}
