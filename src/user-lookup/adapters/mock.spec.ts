/** Mock adapter returns deterministic fields from numeric id parsing. */
import { describe, expect, it } from "vitest";
import { MockAdapter } from "./mock.js";

describe("MockAdapter", () => {
  it("returns deterministic users with open fields", async () => {
    const a = new MockAdapter();
    const m = await a.lookupUsers(["id-42", "id-7"]);
    expect(m.size).toBe(2);
    const u = m.get("id-42")!;
    expect(u.email).toBe("user-id-42@example.com");
    expect(u.fields.first_name).toBeDefined();
    expect(u.user_id).toBe("id-42");
  });
});
