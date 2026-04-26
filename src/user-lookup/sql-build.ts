/**
 * Parameterized SELECT builders shared by the SQL adapter and unit tests.
 */

import type { IdType } from "./mapper.js";
import { validateSafeIdentifier } from "./mapper.js";

export type SqlDialect = "mysql" | "postgres" | "sqlite";

function quoteIdent(dialect: SqlDialect, name: string): string {
  if (!validateSafeIdentifier(name)) {
    throw new Error(`Invalid SQL identifier: ${JSON.stringify(name)}`);
  }
  if (dialect === "mysql") {
    return "`" + name.replace(/`/g, "") + "`";
  }
  return `"` + name.replace(/"/g, '""') + `"`;
}

export function pgArrayCast(idType: IdType): string {
  switch (idType) {
    case "uuid":
      return "uuid";
    case "int":
      return "int";
    case "bigint":
      return "bigint";
    case "string":
    default:
      return "text";
  }
}

export interface SelectUsersQuery {
  text: string;
  values: unknown[];
}

/**
 * Build a batch SELECT for users by id. Postgres uses `= ANY($1::type[])`.
 * MySQL and SQLite use `IN (?,...,?)`.
 */
export function buildSelectUsersQuery(
  dialect: SqlDialect,
  table: string,
  idColumn: string,
  fieldMap: Record<string, string>,
  ids: string[],
  idType: IdType
): SelectUsersQuery {
  if (!validateSafeIdentifier(table) || !validateSafeIdentifier(idColumn)) {
    throw new Error("Invalid table or id_column name");
  }

  const physicalCols = new Set<string>([idColumn]);
  for (const p of Object.values(fieldMap)) {
    if (!validateSafeIdentifier(p)) {
      throw new Error(`Invalid mapped column: ${JSON.stringify(p)}`);
    }
    physicalCols.add(p);
  }

  const selectList = [...physicalCols].map((c) => `${quoteIdent(dialect, c)}`);

  const qt = quoteIdent(dialect, table);
  const qid = quoteIdent(dialect, idColumn);

  if (dialect === "postgres") {
    const cast = pgArrayCast(idType);
    return {
      text: `select ${selectList.join(", ")} from ${qt} where ${qid} = ANY($1::${cast}[])`,
      values: [ids],
    };
  }

  if (ids.length === 0) {
    return {
      text: `select ${selectList.join(", ")} from ${qt} where 1=0`,
      values: [],
    };
  }

  const placeholders = ids.map(() => "?").join(", ");
  return {
    text: `select ${selectList.join(", ")} from ${qt} where ${qid} in (${placeholders})`,
    values: ids,
  };
}

/** SQLite bind limit safety (below default 999) for `IN (?,?,...)`. */
export const SQLITE_MAX_VARS = 900;

export function sqlChunkSize(
  dialect: SqlDialect,
  configuredMax: number
): number {
  if (dialect === "sqlite") {
    return Math.max(1, Math.min(configuredMax, SQLITE_MAX_VARS));
  }
  return Math.max(1, configuredMax);
}
