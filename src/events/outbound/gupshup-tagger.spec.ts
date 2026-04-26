import { describe, expect, it } from "vitest";
import { applyGupshupTag } from "./gupshup-tagger.js";

describe("applyGupshupTag", () => {
  it("passes message through unchanged", () => {
    const m = { a: 1 };
    expect(applyGupshupTag(m, {} as import("../../providers/types.js").SendContext)).toBe(m);
  });
});
