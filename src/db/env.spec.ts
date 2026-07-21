import { describe, expect, it } from "vitest";
import { DEFAULT_SQLITE_FILE, resolveDbEnv } from "./env.js";

const base = { VITEST: "false" } as NodeJS.ProcessEnv;

describe("resolveDbEnv", () => {
  it("defaults to sqlite at the standard file path", () => {
    expect(resolveDbEnv({ ...base })).toEqual({
      dialect: "sqlite",
      file: DEFAULT_SQLITE_FILE,
    });
  });

  it("defaults to in-memory sqlite under vitest", () => {
    expect(resolveDbEnv({ VITEST: "true" } as NodeJS.ProcessEnv)).toEqual({
      dialect: "sqlite",
      file: ":memory:",
    });
  });

  it("uses DISPATCHER_DB_URL as the sqlite file path, stripping file: prefix", () => {
    expect(
      resolveDbEnv({ ...base, DISPATCHER_DB_URL: "file:/var/lib/dispatcher.db" })
    ).toEqual({ dialect: "sqlite", file: "/var/lib/dispatcher.db" });
    expect(resolveDbEnv({ ...base, DISPATCHER_DB_URL: "./x.db" })).toEqual({
      dialect: "sqlite",
      file: "./x.db",
    });
  });

  it("rejects unknown dialects", () => {
    expect(() =>
      resolveDbEnv({ ...base, DISPATCHER_DB_DIALECT: "oracle" })
    ).toThrow(/Invalid DISPATCHER_DB_DIALECT/);
  });

  it("requires a URL or host for mysql/postgres", () => {
    expect(() =>
      resolveDbEnv({ ...base, DISPATCHER_DB_DIALECT: "mysql" })
    ).toThrow(/DISPATCHER_DB_URL or DISPATCHER_DB_HOST/);
  });

  it("passes a mysql URL through", () => {
    const env = resolveDbEnv({
      ...base,
      DISPATCHER_DB_DIALECT: "mysql",
      DISPATCHER_DB_URL: "mysql://u:p@db:3306/dispatcher_state",
    });
    expect(env).toMatchObject({ dialect: "mysql", url: "mysql://u:p@db:3306/dispatcher_state" });
  });

  it("assembles discrete postgres settings with dialect defaults", () => {
    const env = resolveDbEnv({
      ...base,
      DISPATCHER_DB_DIALECT: "postgres",
      DISPATCHER_DB_HOST: "pg.internal",
      DISPATCHER_DB_PASSWORD: "secret",
    });
    expect(env).toMatchObject({
      dialect: "postgres",
      url: null,
      host: "pg.internal",
      port: 5432,
      user: "postgres",
      password: "secret",
      database: "dispatcher_state",
    });
  });

  it("assembles discrete mysql settings", () => {
    const env = resolveDbEnv({
      ...base,
      DISPATCHER_DB_DIALECT: "mysql",
      DISPATCHER_DB_HOST: "mysql",
      DISPATCHER_DB_PORT: "3307",
      DISPATCHER_DB_USER: "dispatcher",
      DISPATCHER_DB_PASSWORD: "pw",
      DISPATCHER_DB_NAME: "state",
    });
    expect(env).toMatchObject({
      dialect: "mysql",
      host: "mysql",
      port: 3307,
      user: "dispatcher",
      password: "pw",
      database: "state",
    });
  });
});
