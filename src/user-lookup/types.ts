/**
 * Adapter contract: `lookupUsers` keys the map with the **wire** ids from the dispatch payload.
 */

import type { LookupChannel } from "./channel.js";

export interface UserRecord {
  user_id: string;
  /** Empty on a WhatsApp lookup: the address is never asked for there. */
  email: string;
  fields: Record<string, string | undefined>;
}

export interface UserLookupAdapter {
  /**
   * `channel` decides which contact field is fetched and required — see
   * channel.ts. Defaults to `email`.
   */
  lookupUsers(userIds: string[], channel?: LookupChannel): Promise<Map<string, UserRecord>>;
  /**
   * Run a scalar SELECT for a `query` variable, binding {{token}} params.
   * Returns the first row / first column, or null. Only the SQL backends
   * implement this; others throw.
   */
  /**
   * Every column of the source view, for picking a `field` variable. Only the
   * SQL backends implement this; other modes have no columns to offer.
   */
  listSourceColumns?(): Promise<string[]>;
  runScalarQuery?(
    namedSql: string,
    bindings: Record<string, string>
  ): Promise<string | null>;
}
