/** Mock adapter returns deterministic fields from numeric id parsing. */
import { describe, expect, it } from "vitest";
import { MockAdapter } from "./mock.js";

describe("MockAdapter", () => {
  it("returns deterministic users with contact details only", async () => {
    const a = new MockAdapter();
    const m = await a.lookupUsers(["id-42", "id-7"]);
    expect(m.size).toBe(2);
    const u = m.get("id-42")!;
    expect(u.email).toBe("user-id-42@example.com");
    // Like every lookup mode: email and phone, nothing else.
    expect(Object.keys(u.fields).sort()).toEqual(["email", "phone"]);
    expect(u.user_id).toBe("id-42");
  });
});
