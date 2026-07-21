/**
 * State-DB client factory + process singleton.
 * The dispatcher's own database (variables, activity, logs, outbox) — NOT the
 * client user-lookup DB (see src/user-lookup/adapters/sql.ts for that one).
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzleMysql } from "drizzle-orm/mysql2";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { createPool } from "mysql2/promise";
import { Pool as PgPool } from "pg";
import { resolveDbEnv, type DispatcherDbEnv } from "./env.js";
import { tablesByDialect } from "./schema/index.js";
import type { DispatcherDb } from "./types.js";

export type { DispatcherDb } from "./types.js";
export {
  getDb,
  isDbInitialized,
  setDbSingleton,
  setDbForTests,
  resetDbForTests,
} from "./state.js";

export function createDispatcherDb(env: {
  dialect: "sqlite";
  file: string;
}): Extract<DispatcherDb, { dialect: "sqlite" }>;
export function createDispatcherDb(env?: DispatcherDbEnv): DispatcherDb;
export function createDispatcherDb(env?: DispatcherDbEnv): DispatcherDb {
  const resolved = env ?? resolveDbEnv();

  if (resolved.dialect === "sqlite") {
    if (resolved.file !== ":memory:") {
      mkdirSync(dirname(resolved.file), { recursive: true });
    }
    const sqlite = new Database(resolved.file);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("busy_timeout = 5000");
    return {
      dialect: "sqlite",
      db: drizzleSqlite(sqlite),
      tables: tablesByDialect.sqlite,
      sqlite,
    };
  }

  if (resolved.dialect === "mysql") {
    const pool = resolved.url
      ? createPool({ uri: resolved.url, waitForConnections: true, connectionLimit: 5 })
      : createPool({
          host: resolved.host,
          port: resolved.port,
          user: resolved.user,
          password: resolved.password,
          database: resolved.database,
          waitForConnections: true,
          connectionLimit: 5,
        });
    return {
      dialect: "mysql",
      db: drizzleMysql(pool),
      tables: tablesByDialect.mysql,
      pool,
    };
  }

  const pool = resolved.url
    ? new PgPool({ connectionString: resolved.url, max: 5 })
    : new PgPool({
        host: resolved.host,
        port: resolved.port,
        user: resolved.user,
        password: resolved.password,
        database: resolved.database,
        max: 5,
      });
  return {
    dialect: "postgres",
    db: drizzlePg(pool),
    tables: tablesByDialect.postgres,
    pool,
  };
}
