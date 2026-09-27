/**
 * The `dispatcher:` block, and the four settings it can take over from the
 * environment.
 *
 * The load-bearing case is the last describe: with no block at all, every
 * existing deployment must behave exactly as it did before this file existed.
 * That is what makes the change safe to ship without touching a single client's
 * configuration.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvYamlForTests, setEnvYamlForTests, type EnvYaml } from "./env-yaml.js";
import { dispatcherSchema } from "./dispatcher-schema.js";
import {
  DEFAULT_PORT,
  danglingAtlasKeyRef,
  dispatcherPort,
  dispatcherPublicUrl,
  resolveAtlasKey,
  resolveCorsOrigins,
} from "./dispatcher-settings.js";

/** Inject a .env.yaml carrying only a `dispatcher:` block. */
function useBlock(dispatcher: unknown): void {
  setEnvYamlForTests({ version: 1, senders: [], dispatcher } as unknown as EnvYaml);
}

beforeEach(() => resetEnvYamlForTests());
afterEach(() => {
  resetEnvYamlForTests();
  vi.unstubAllEnvs();
});

describe("port", () => {
  it("takes the yaml value", () => {
    useBlock({ port: 8080 });
    expect(dispatcherPort()).toBe(8080);
  });

  it("coerces a quoted integer — templated values files produce strings", () => {
    useBlock({ port: "8080" });
    expect(dispatcherPort()).toBe(8080);
  });

  it("falls back to PORT", () => {
    vi.stubEnv("PORT", "4000");
    expect(dispatcherPort()).toBe(4000);
  });

  it("defaults when neither is set", () => {
    expect(dispatcherPort()).toBe(DEFAULT_PORT);
  });

  // parseInt("http://…") is NaN, and listen(NaN) picks a random port — the
  // dispatcher then answers on an address nobody is routing to.
  it.each(["", "not-a-port", "0", "70000"])("ignores an unusable PORT=%s", (value) => {
    vi.stubEnv("PORT", value);
    expect(dispatcherPort()).toBe(DEFAULT_PORT);
  });

  it("rejects an out-of-range yaml port at parse time", () => {
    expect(() => dispatcherSchema.parse({ port: 70000 })).toThrow();
  });
});

describe("public_url", () => {
  it("takes the yaml value and strips trailing slashes", () => {
    useBlock({ public_url: "https://d.example.com///" });
    expect(dispatcherPublicUrl()).toBe("https://d.example.com");
  });

  it("falls back to DISPATCHER_PUBLIC_URL", () => {
    vi.stubEnv("DISPATCHER_PUBLIC_URL", "https://env.example.com/");
    expect(dispatcherPublicUrl()).toBe("https://env.example.com");
  });

  it("is null when unset, so callers keep their own fallbacks", () => {
    expect(dispatcherPublicUrl()).toBeNull();
  });

  it("rejects a non-absolute URL at parse time", () => {
    expect(() => dispatcherSchema.parse({ public_url: "dispatcher.example.com" })).toThrow();
  });
});

describe("atlas_key", () => {
  it("takes an inline key", () => {
    useBlock({ atlas_key: "k".repeat(40) });
    expect(resolveAtlasKey()).toMatchObject({ source: "env.yaml" });
  });

  it("resolves atlas_key_env against the environment", () => {
    vi.stubEnv("MY_KEY", "from-named-var");
    useBlock({ atlas_key_env: "MY_KEY" });
    expect(resolveAtlasKey()).toEqual({ value: "from-named-var", source: "env.yaml" });
  });

  it("falls back to DISPATCHER_ATLAS_KEY", () => {
    vi.stubEnv("DISPATCHER_ATLAS_KEY", "from-env");
    expect(resolveAtlasKey()).toEqual({ value: "from-env", source: "env" });
  });

  // A real environment variable beats the file. By the time anything calls in
  // here, hydration has already copied the file's value into process.env — so
  // an environment value that DIFFERS from the file was injected by the
  // platform, and overriding a rotated Kubernetes Secret with a stale mounted
  // file is precisely the failure this ordering prevents.
  it("prefers the environment over yaml, and says the value came from the environment", () => {
    vi.stubEnv("DISPATCHER_ATLAS_KEY", "from-env");
    useBlock({ atlas_key: "from-yaml" });
    expect(resolveAtlasKey()).toEqual({ value: "from-env", source: "env" });
  });

  // Same value in both places means hydration put it there, not an operator.
  it("attributes the value to the file when the environment merely echoes it", () => {
    vi.stubEnv("DISPATCHER_ATLAS_KEY", "same-value");
    useBlock({ atlas_key: "same-value" });
    expect(resolveAtlasKey()).toEqual({ value: "same-value", source: "env.yaml" });
  });

  // The whole data-plane fails closed on null. It must never fall open.
  it("is null when configured nowhere — the Atlas API stays OFF", () => {
    expect(resolveAtlasKey()).toBeNull();
  });

  it("rejects setting both forms — one would be silently ignored", () => {
    expect(() => dispatcherSchema.parse({ atlas_key: "a", atlas_key_env: "B" })).toThrow();
  });

  describe("a dangling atlas_key_env", () => {
    it("is reported", () => {
      useBlock({ atlas_key_env: "NOT_SET_ANYWHERE" });
      expect(danglingAtlasKeyRef()).toBe("NOT_SET_ANYWHERE");
    });

    // Disabling the API because a reference was mistyped, while a perfectly
    // good key sits in the environment, would be a self-inflicted outage.
    it("still falls back rather than disabling the API", () => {
      vi.stubEnv("DISPATCHER_ATLAS_KEY", "from-env");
      useBlock({ atlas_key_env: "NOT_SET_ANYWHERE" });
      expect(resolveAtlasKey()).toEqual({ value: "from-env", source: "env" });
    });
  });
});

describe("atlas_cors_origins", () => {
  it("accepts a list", () => {
    useBlock({ atlas_cors_origins: ["https://a.example", "https://b.example"] });
    expect(resolveCorsOrigins()).toEqual({
      entries: ["https://a.example", "https://b.example"],
      source: "env.yaml",
    });
  });

  // What someone pasting the old environment variable will write.
  it("accepts a comma-separated string", () => {
    useBlock({ atlas_cors_origins: "https://a.example, https://b.example" });
    expect(resolveCorsOrigins()?.entries).toEqual(["https://a.example", "https://b.example"]);
  });

  it("falls back to the environment variable", () => {
    vi.stubEnv("DISPATCHER_ATLAS_CORS_ORIGINS", "https://env.example");
    expect(resolveCorsOrigins()).toEqual({ entries: ["https://env.example"], source: "env" });
  });

  it("treats an explicit empty list as configured-and-empty, not unset", () => {
    useBlock({ atlas_cors_origins: [] });
    expect(resolveCorsOrigins()).toEqual({ entries: [], source: "env.yaml" });
  });

  it("is null when unset anywhere", () => {
    expect(resolveCorsOrigins()).toBeNull();
  });
});

describe("the schema", () => {
  // A typo in a security setting must fail loudly, not be ignored.
  it("rejects an unknown key", () => {
    expect(() => dispatcherSchema.parse({ atlas_keys: "typo" })).toThrow();
  });

  it("accepts an empty block", () => {
    expect(dispatcherSchema.parse({})).toEqual({});
  });
});

// The reason this change is safe to ship.
describe("no dispatcher block at all", () => {
  it("reads every setting from the environment, exactly as before", () => {
    vi.stubEnv("PORT", "4000");
    vi.stubEnv("DISPATCHER_PUBLIC_URL", "https://legacy.example.com");
    vi.stubEnv("DISPATCHER_ATLAS_KEY", "legacy-key");
    vi.stubEnv("DISPATCHER_ATLAS_CORS_ORIGINS", "https://legacy.example.com");
    setEnvYamlForTests({ version: 1, senders: [] } as unknown as EnvYaml);

    expect(dispatcherPort()).toBe(4000);
    expect(dispatcherPublicUrl()).toBe("https://legacy.example.com");
    expect(resolveAtlasKey()).toEqual({ value: "legacy-key", source: "env" });
    expect(resolveCorsOrigins()?.source).toBe("env");
    expect(danglingAtlasKeyRef()).toBeNull();
  });
});
