/**
 * State-DB client factory + process singleton.
 * The dispatcher's own database (variables, activity, logs, outbox) — NOT the
 * client user-lookup DB (see src/user-lookup/adapters/sql.ts for that one).
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  drizzle as drizzleSqlite,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";
import { drizzle as drizzleMysql, type MySql2Database } from "drizzle-orm/mysql2";
import {
  drizzle as drizzlePg,
  type NodePgDatabase,
} from "drizzle-orm/node-postgres";
import { createPool, type Pool as MysqlPool } from "mysql2/promise";
import { Pool as PgPool } from "pg";
import { resolveDbEnv, type DispatcherDbEnv } from "./env.js";
import { tablesByDialect, type MysqlTables, type PgTables, type SqliteTables } from "./schema/index.js";

export type DispatcherDb =
  | {
      dialect: "sqlite";
      db: BetterSQLite3Database;
      tables: SqliteTables;
      sqlite: Database.Database;
    }
  | {
      dialect: "mysql";
      db: MySql2Database;
      tables: MysqlTables;
      pool: MysqlPool;
    }
  | {
      dialect: "postgres";
      db: NodePgDatabase;
      tables: PgTables;
      pool: PgPool;
    };

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

let singleton: DispatcherDb | null = null;

/** The active state DB. Throws if initDispatcherDb() has not run yet. */
export function getDb(): DispatcherDb {
  if (!singleton) {
    throw new Error(
      "Dispatcher state DB not initialized — initDispatcherDb() must run at startup before repos are used"
    );
  }
  return singleton;
}

/** Whether the state DB has been initialized (used by soft consumers like the log sink). */
export function isDbInitialized(): boolean {
  return singleton !== null;
}

export function setDbSingleton(dbx: DispatcherDb): void {
  singleton = dbx;
}

export function setDbForTests(dbx: DispatcherDb): void {
  singleton = dbx;
}

export function resetDbForTests(): void {
  singleton = null;
}
