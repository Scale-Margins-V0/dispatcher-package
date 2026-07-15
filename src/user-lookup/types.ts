/**
 * Adapter contract: `lookupUsers` keys the map with the **wire** ids from the dispatch payload.
 */

export interface UserRecord {
  user_id: string;
  email: string;
  fields: Record<string, string | undefined>;
}

export interface UserLookupAdapter {
  lookupUsers(userIds: string[]): Promise<Map<string, UserRecord>>;
  /**
   * Run a scalar SELECT for a `query` variable, binding {{token}} params.
   * Returns the first row / first column, or null. Only the SQL backends
   * implement this; others throw.
   */
  runScalarQuery?(
    namedSql: string,
    bindings: Record<string, string>
  ): Promise<string | null>;
}
