/**
 * The DispatcherDb shape, in a type-only module. Importing this pulls in NO
 * runtime driver code (all imports are `import type`), so lightweight guards
 * like isDbInitialized() can be imported on hot paths without loading drizzle.
 */

import type Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { MySql2Database } from "drizzle-orm/mysql2";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool as MysqlPool } from "mysql2/promise";
import type { Pool as PgPool } from "pg";
import type { MysqlTables, PgTables, SqliteTables } from "./schema/index.js";

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
