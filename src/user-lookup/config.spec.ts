/**
 * Zod parsing, disk load / missing file fallback, `USER_LOOKUP_BACKEND` env override.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadDispatchConfigFromDisk,
  parseDispatchConfig,
  parseDispatchYaml,
  resetDispatchConfigForTests,
} from "./config.js";

describe("parseDispatchConfig", () => {
  it("accepts minimal http backend", () => {
    const cfg = parseDispatchConfig({
      user_lookup: {
        backend: "http",
        fields: { email: "contact.email" },
        http: {
          base_url: "https://example.com",
          path: "/v1/batch",
          method: "POST",
          auth: { type: "bearer", token_env: "T" },
          request: { id_field: "ids" },
          response: { root: "data.users", id_field: "id" },
        },
      },
      placeholders: {
        email: { source: "field", field: "email" },
      },
    });
    expect(cfg.user_lookup.backend).toBe("http");
    expect(cfg.user_lookup.http?.base_url).toBe("https://example.com");
  });

  it("accepts source.kind view for sqlite (name is the view identifier in FROM)", () => {
    const cfg = parseDispatchConfig({
      user_lookup: {
        backend: "sqlite",
        source: {
          kind: "view",
          name: "v_customers",
          id_column: "user_id",
          id_type: "string",
        },
        sqlite: { file: ":memory:" },
        fields: { email: "email" },
      },
      placeholders: {
        email: { source: "field", field: "email" },
      },
    });
    expect(cfg.user_lookup.source?.kind).toBe("view");
    expect(cfg.user_lookup.source?.name).toBe("v_customers");
  });

  it("rejects http backend without http block", () => {
    expect(() =>
      parseDispatchConfig({
        user_lookup: {
          backend: "http",
          fields: { email: "e" },
        },
        placeholders: {},
      })
    ).toThrow();
  });

  it("rejects unknown backend", () => {
    expect(() =>
      parseDispatchConfig({
        user_lookup: {
          backend: "dynamo",
          fields: {},
        },
        placeholders: {},
      })
    ).toThrow();
  });
});

describe("loadDispatchConfigFromDisk + env", () => {
  const origPath = process.env.USER_LOOKUP_CONFIG_PATH;

  afterEach(() => {
    resetDispatchConfigForTests();
    if (origPath === undefined) {
      delete process.env.USER_LOOKUP_CONFIG_PATH;
    } else {
      process.env.USER_LOOKUP_CONFIG_PATH = origPath;
    }
    delete process.env.USER_LOOKUP_BACKEND;
  });

  it("falls back to mock when config file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-cfg-"));
    process.env.USER_LOOKUP_CONFIG_PATH = join(dir, "nope.yaml");
    resetDispatchConfigForTests();
    const cfg = loadDispatchConfigFromDisk();
    expect(cfg.user_lookup.backend).toBe("mock");
  });

  it("USER_LOOKUP_BACKEND overrides yaml backend", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-cfg-"));
    const p = join(dir, "dispatch.yaml");
    writeFileSync(
      p,
      `
user_lookup:
  backend: mysql
  source:
    name: users
    id_column: user_id
    id_type: string
  fields:
    email: email
placeholders:
  email: { source: field, field: email }
`
    );
    process.env.USER_LOOKUP_CONFIG_PATH = p;
    process.env.USER_LOOKUP_BACKEND = "mock";
    resetDispatchConfigForTests();
    const cfg = loadDispatchConfigFromDisk();
    expect(cfg.user_lookup.backend).toBe("mock");
  });
});

describe("parseDispatchYaml", () => {
  it("throws on invalid yaml", () => {
    expect(() => parseDispatchYaml("\t:\n")).toThrow();
  });
});
