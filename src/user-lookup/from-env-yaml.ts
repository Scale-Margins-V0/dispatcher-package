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
import { componentLogger } from "../logging/logger.js";
import { LogComponent } from "../logging/conventions.js";
import { CONTACT_FIELD_NAMES } from "./channel.js";
import { DEFAULT_PLACEHOLDERS } from "./placeholders.js";
import type { UserLookupYaml } from "./schema.js";

const log = componentLogger(LogComponent.config);

/**
 * Network mode resolves contact details only. Anything else in `fields:` is
 * dropped with a warning rather than failing the boot: it is a leftover from
 * before the lookup was contact-only, and it can do no harm once ignored.
 */
function contactFieldsOnly(fields: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  const ignored: string[] = [];
  for (const [logical, remote] of Object.entries(fields)) {
    if (CONTACT_FIELD_NAMES.has(logical)) kept[logical] = remote;
    else ignored.push(logical);
  }
  if (ignored.length > 0) {
    log.warn(
      { ignored_fields: ignored, error_category: "ignored_lookup_fields" },
      `user_lookup.fields: ignoring ${ignored.join(", ")} — network mode looks up email and phone only. ` +
        "Personalize with variables (api, computed, constant) instead."
    );
  }
  return kept;
}

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
      user_lookup: { ...shared, fields: contactFieldsOnly(lookup.fields), network: lookup.network },
      placeholders: DEFAULT_PLACEHOLDERS,
    };
  }

  return { user_lookup: shared, placeholders: DEFAULT_PLACEHOLDERS };
}
