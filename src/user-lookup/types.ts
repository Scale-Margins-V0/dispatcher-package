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
}
