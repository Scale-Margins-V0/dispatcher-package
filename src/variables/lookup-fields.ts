/**
 * What a `field` variable can point at, for the variable builder's picker.
 *
 * Database mode: every column of the source view except the id column and the
 * columns already exposed as the `email` / `phone` system variables.
 * Network and mock mode: nothing — the lookup returns contact details only, so
 * `field` variables are unavailable there.
 */

import { getDispatchConfig } from "../user-lookup/config.js";
import { getLookupAdapter } from "../user-lookup/index.js";
import { CONTACT_FIELD_NAMES } from "../user-lookup/channel.js";
import { isSourceSupported, lookupMode } from "./guard.js";

export type LookupFields = {
  mode: "database" | "network" | "mock";
  field_source_supported: boolean;
  /**
   * Where `fields` come from — the table or view in `user_lookup.source`.
   * Shown read-only in the builder; null outside database mode.
   */
  source: { kind: "table" | "view"; name: string } | null;
  /** Always resolved by the lookup; exposed as system variables. */
  contact_fields: string[];
  /** Columns a `field` variable may read. Empty outside database mode. */
  fields: string[];
};

export async function lookupFields(): Promise<LookupFields> {
  const mode = lookupMode();
  const supported = isSourceSupported("field");
  const ul = getDispatchConfig().user_lookup;
  const base = {
    mode,
    field_source_supported: supported,
    source: supported && ul.source ? { kind: ul.source.kind, name: ul.source.name } : null,
    contact_fields: ["email", "phone"],
  };
  const adapter = getLookupAdapter();
  if (!supported || !adapter.listSourceColumns) return { ...base, fields: [] };

  const hidden = new Set<string>(ul.source ? [ul.source.id_column] : []);
  for (const [logical, column] of Object.entries(ul.fields)) {
    if (CONTACT_FIELD_NAMES.has(logical)) hidden.add(column);
  }
  const columns = await adapter.listSourceColumns();
  return { ...base, fields: columns.filter((c) => !hidden.has(c)) };
}
