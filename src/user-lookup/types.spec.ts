/** Compile-time checks for adapter contract types. */
import { describe, expectTypeOf, it } from "vitest";
import type { UserLookupAdapter, UserRecord } from "./types.js";

describe("UserRecord", () => {
  it("has open fields map plus required identifiers", () => {
    expectTypeOf<UserRecord>().toMatchTypeOf<{
      user_id: string;
      email: string;
      fields: Record<string, string | undefined>;
    }>();
  });
});

describe("UserLookupAdapter", () => {
  it("lookupUsers returns a Map keyed by user id", () => {
    expectTypeOf<UserLookupAdapter["lookupUsers"]>().returns.toEqualTypeOf<
      Promise<Map<string, UserRecord>>
    >();
  });
});
