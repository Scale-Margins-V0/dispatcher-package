/**
 * Deterministic synthetic users (no DB/API) when `user_lookup.backend` is `mock`.
 *
 * Contact details only, like every lookup mode: personalization comes from
 * variables, not the lookup.
 */

import { componentLogger } from "../../logging/logger.js";
import type { UserLookupAdapter, UserRecord } from "../types.js";

const log = componentLogger("user-lookup.mock");

export class MockAdapter implements UserLookupAdapter {
  async lookupUsers(userIds: string[]): Promise<Map<string, UserRecord>> {
    const result = new Map<string, UserRecord>();
    for (const id of userIds) {
      const num = parseInt(id.replace(/\D/g, ""), 10) || 0;
      const email = `user-${id}@example.com`;
      result.set(id, {
        user_id: id,
        email,
        fields: {
          email,
          phone: `+9198765${String(num).padStart(5, "0")}`,
        },
      });
    }
    if (process.env.VITEST !== "true") {
      log.info(
        `[UserLookup] Resolved ${result.size}/${userIds.length} users (mock mode)`
      );
    }
    return result;
  }
}
