/**
 * Singleton adapter wiring: same instance until `resetLookupAdapterForTests`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetDispatchConfigForTests } from "./config.js";
import { getLookupAdapter, resetLookupAdapterForTests } from "./index.js";

describe("user-lookup factory", () => {
  afterEach(() => {
    resetDispatchConfigForTests();
    resetLookupAdapterForTests();
    delete process.env.USER_LOOKUP_BACKEND;
    delete process.env.USER_LOOKUP_CONFIG_PATH;
  });

  it("returns the same adapter instance (singleton)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ul-fac-"));
    process.env.USER_LOOKUP_CONFIG_PATH = join(dir, "missing.yaml");
    resetDispatchConfigForTests();
    resetLookupAdapterForTests();
    const a1 = getLookupAdapter();
    const a2 = getLookupAdapter();
    expect(a1).toBe(a2);
  });
});
