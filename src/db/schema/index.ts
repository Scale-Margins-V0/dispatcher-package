import * as mysqlTables from "./mysql.js";
import * as pgTables from "./pg.js";
import * as sqliteTables from "./sqlite.js";

export const tablesByDialect = {
  sqlite: sqliteTables,
  mysql: mysqlTables,
  postgres: pgTables,
} as const;

export type SqliteTables = typeof sqliteTables;
export type MysqlTables = typeof mysqlTables;
export type PgTables = typeof pgTables;

export * from "./shared.js";
