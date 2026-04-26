/**
 * Deterministic synthetic users (no DB/API) when `user_lookup.backend` is `mock`.
 */

import type { UserLookupAdapter, UserRecord } from "../types.js";

export class MockAdapter implements UserLookupAdapter {
  async lookupUsers(userIds: string[]): Promise<Map<string, UserRecord>> {
    const result = new Map<string, UserRecord>();
    for (const id of userIds) {
      const num = parseInt(id.replace(/\D/g, ""), 10) || 0;
      const firstName = ["Nikhil", "Priya", "Rahul", "Anita", "Vikram"][num % 5]!;
      const lastName = ["Singh", "Sharma", "Patel", "Gupta", "Kumar"][num % 5]!;
      const company = ["Acme Corp", "Tata Digital", "Infosys", "Reliance", "Wipro"][num % 5]!;
      const email = `user-${id}@example.com`;
      result.set(id, {
        user_id: id,
        email,
        fields: {
          first_name: firstName,
          last_name: lastName,
          email,
          phone: `+9198765${String(num).padStart(5, "0")}`,
          company_name: company,
        },
      });
    }
    if (process.env.VITEST !== "true") {
      console.log(
        `[UserLookup] Resolved ${result.size}/${userIds.length} users (mock mode)`
      );
    }
    return result;
  }
}
