/**
 * The query-variable guard.
 *
 * The load-bearing assertion is the last one: what `/state` advertises has to
 * be exactly what the write guard enforces. If those two drift, the platform
 * offers an option the dispatcher will refuse, and the operator gets a 422 for
 * a choice the UI just told them was available.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetDispatchConfigForTests,
  setDispatchConfigForTests,
  type DispatchConfig,
} from "../user-lookup/config.js";
import { VARIABLE_SOURCES } from "../user-lookup/placeholders.js";
import {
  inactiveSources,
  isSourceSupported,
  lookupMode,
  supportedVariableSources,
  unsupportedSourceMessage,
} from "./guard.js";

function useConfig(lookup: Partial<DispatchConfig["user_lookup"]>): void {
  setDispatchConfigForTests({
    user_lookup: { backend: "mock", fields: {}, ...lookup },
    placeholders: {},
  } as DispatchConfig);
}

const asDatabase = () => useConfig({ backend: "postgres", fields: { email: "email" } });
const asNetwork = () =>
  useConfig({
    backend: "http",
    fields: { email: "email" },
    network: { url: "https://x.example/lookup", token: "t", timeout_ms: 3000, retries: 2 },
  });
const asMock = () => useConfig({ backend: "mock" });

beforeEach(() => resetDispatchConfigForTests());
afterEach(() => resetDispatchConfigForTests());

describe("lookupMode", () => {
  it.each(["postgres", "mysql", "sqlite"] as const)("reports database for %s", (backend) => {
    useConfig({ backend, fields: {} });
    expect(lookupMode()).toBe("database");
  });

  it("reports network when a network block is present", () => {
    asNetwork();
    expect(lookupMode()).toBe("network");
  });

  it("reports mock when nothing can be read", () => {
    asMock();
    expect(lookupMode()).toBe("mock");
  });
});

describe("supported sources", () => {
  it("allows every source when there is a SQL connection", () => {
    asDatabase();
    expect(supportedVariableSources()).toEqual([...VARIABLE_SOURCES]);
    expect(isSourceSupported("query")).toBe(true);
  });

  it("drops query in network mode — there is no database to query", () => {
    asNetwork();
    expect(supportedVariableSources()).not.toContain("query");
    expect(isSourceSupported("query")).toBe(false);
  });

  it("keeps every other source in network mode", () => {
    asNetwork();
    for (const source of ["field", "computed", "constant", "api"] as const) {
      expect(isSourceSupported(source)).toBe(true);
    }
  });

  it("drops query in mock mode too", () => {
    asMock();
    expect(isSourceSupported("query")).toBe(false);
  });
});

describe("inactiveSources", () => {
  it("is empty with a SQL connection", () => {
    asDatabase();
    expect(inactiveSources()).toEqual([]);
  });

  it("names query without one, so the snapshot can skip those rows", () => {
    asNetwork();
    expect(inactiveSources()).toEqual(["query"]);
  });
});

describe("the refusal message", () => {
  it("names the source and the mode that refused it", () => {
    asNetwork();
    const message = unsupportedSourceMessage("query");
    expect(message).toContain("query");
    expect(message).toContain("network");
  });
});

// The invariant the whole design rests on.
describe("the advertised list and the enforced rule cannot drift", () => {
  it.each([
    ["database", asDatabase],
    ["network", asNetwork],
    ["mock", asMock],
  ] as const)("agree in %s mode", (_mode, apply) => {
    apply();
    const advertised = supportedVariableSources();
    for (const source of VARIABLE_SOURCES) {
      expect(isSourceSupported(source)).toBe(advertised.includes(source));
    }
  });
});
