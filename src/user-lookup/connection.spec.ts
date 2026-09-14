/**
 * Credential precedence. The failure this guards against is quiet: a dispatcher
 * that connects to the wrong database reads real rows and mails real people,
 * so "which source won" has to be unambiguous.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  missingConnectionFields,
  resetConnectionWarningForTests,
  resolveConnection,
} from "./connection.js";

beforeEach(() => resetConnectionWarningForTests());
afterEach(() => vi.unstubAllEnvs());

const full = {
  host: "db.internal",
  port: 5432,
  user: "ro",
  password: "pw",
  database: "customers",
  ssl: true,
};

describe("precedence", () => {
  it("uses the inline connection when present", () => {
    const c = resolveConnection("postgres", full);
    expect(c).toMatchObject({ ...full, from: "env.yaml" });
  });

  it("falls back to DB_* when there is no connection block", () => {
    vi.stubEnv("DB_HOST", "env-host");
    vi.stubEnv("DB_USER", "env-user");
    vi.stubEnv("DB_PASSWORD", "env-pw");
    vi.stubEnv("DB_NAME", "env-db");
    const c = resolveConnection("postgres", undefined);
    expect(c).toMatchObject({ host: "env-host", user: "env-user", database: "env-db", from: "env" });
  });

  // Precedence is per file, not per key: a config that half-wins is the thing
  // nobody can debug at 3am.
  it("does not merge — an inline block ignores DB_* entirely", () => {
    vi.stubEnv("DB_HOST", "env-host");
    expect(resolveConnection("postgres", { user: "ro" }).host).toBe("localhost");
  });

  it("treats an empty connection block as absent", () => {
    vi.stubEnv("DB_HOST", "env-host");
    expect(resolveConnection("postgres", {}).from).toBe("env");
  });
});

describe("defaults", () => {
  it.each([
    ["mysql", 3306, "root", "mysql"],
    ["postgres", 5432, "postgres", "postgres"],
  ] as const)("%s fills port/user/database", (backend, port, user, database) => {
    expect(resolveConnection(backend, { host: "h" })).toMatchObject({ port, user, database });
  });

  it("defaults ssl to off", () => {
    expect(resolveConnection("postgres", { host: "h" }).ssl).toBe(false);
  });

  it.each(["true", "1"])("reads DB_SSL=%s as enabled", (value) => {
    vi.stubEnv("DB_SSL", value);
    expect(resolveConnection("postgres", undefined).ssl).toBe(true);
  });
});

describe("the password", () => {
  it("prefers an inline password over password_env", () => {
    vi.stubEnv("PW", "from-env");
    expect(resolveConnection("postgres", { ...full, password_env: "PW" }).password).toBe("pw");
  });

  it("reads password_env when there is no inline password", () => {
    vi.stubEnv("PW", "from-env");
    const { password: _drop, ...noPassword } = full;
    void _drop;
    expect(resolveConnection("postgres", { ...noPassword, password_env: "PW" }).password).toBe(
      "from-env"
    );
  });

  it("accepts an explicit empty inline password", () => {
    const c = resolveConnection("postgres", { ...full, password: "" });
    expect(c.password).toBe("");
    expect(missingConnectionFields("postgres", c, { ...full, password: "" })).toEqual([]);
  });
});

describe("missingConnectionFields", () => {
  it("is empty for a complete inline connection", () => {
    expect(missingConnectionFields("postgres", resolveConnection("postgres", full), full)).toEqual([]);
  });

  it("names the yaml keys when the connection came from .env.yaml", () => {
    const conn = { password: "pw" };
    const missing = missingConnectionFields("postgres", resolveConnection("postgres", conn), conn);
    expect(missing).toEqual([
      "user_lookup.connection.host",
      "user_lookup.connection.user",
      "user_lookup.connection.database",
    ]);
  });

  it("names the environment variables when it came from DB_*", () => {
    const c = resolveConnection("postgres", undefined);
    expect(missingConnectionFields("postgres", c, undefined)).toEqual([
      "DB_HOST",
      "DB_USER",
      "DB_NAME",
      "DB_PASSWORD",
    ]);
  });

  // An unset variable is ambiguous — it could be a typo. An inline "" is not.
  it("accepts an empty env password only with DB_ALLOW_EMPTY_PASSWORD", () => {
    vi.stubEnv("DB_HOST", "h");
    vi.stubEnv("DB_USER", "u");
    vi.stubEnv("DB_NAME", "d");
    const c = resolveConnection("postgres", undefined);
    expect(missingConnectionFields("postgres", c, undefined)).toEqual(["DB_PASSWORD"]);

    vi.stubEnv("DB_ALLOW_EMPTY_PASSWORD", "true");
    expect(missingConnectionFields("postgres", resolveConnection("postgres", undefined), undefined)).toEqual(
      []
    );
  });

  it("requires nothing for sqlite — the path is resolved separately", () => {
    expect(
      missingConnectionFields("sqlite", resolveConnection("sqlite", undefined), undefined)
    ).toEqual([]);
  });
});
