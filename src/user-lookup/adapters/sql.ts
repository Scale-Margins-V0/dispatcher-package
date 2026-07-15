/**
 * SQL user lookup: pools per dialect, `buildSelectUsersQuery` for batched IN / ANY lookups.
 */

import Database from "better-sqlite3";
import { createPool, type Pool as MysqlPool } from "mysql2/promise";
import { Pool as PgPool } from "pg";
import { componentLogger } from "../../logging/logger.js";
import type { DispatchConfig } from "../config.js";
import { getIdType, getSqliteFile } from "../config.js";
import {
  chunkArray,
  coerceIdForType,
  mapSqlRowToUserRecord,
  type IdType,
} from "../mapper.js";
import {
  buildSelectUsersQuery,
  sqlChunkSize,
  type SqlDialect,
} from "../sql-build.js";
import type { UserLookupAdapter, UserRecord } from "../types.js";

const log = componentLogger("user-lookup.sql");

export class SqlAdapter implements UserLookupAdapter {
  private mysqlPool: MysqlPool | null = null;
  private pgPool: PgPool | null = null;
  private sqliteDb: Database.Database | null = null;

  constructor(private readonly cfg: DispatchConfig) {}

  private get dialect(): SqlDialect {
    const b = this.cfg.user_lookup.backend;
    if (b === "mysql" || b === "postgres" || b === "sqlite") return b;
    throw new Error(`SqlAdapter used with backend ${b}`);
  }

  private getMysqlPool(): MysqlPool {
    if (!this.mysqlPool) {
      this.mysqlPool = createPool({
        host: process.env.DB_HOST || "localhost",
        port: parseInt(process.env.DB_PORT || "3306", 10),
        user: process.env.DB_USER || "root",
        password:
          process.env.DB_PASSWORD ??
          (process.env.DB_ALLOW_EMPTY_PASSWORD === "true" ? "" : ""),
        database: process.env.DB_NAME || "mysql",
        waitForConnections: true,
        connectionLimit: 10,
      });
    }
    return this.mysqlPool;
  }

  private getPgPool(): PgPool {
    if (!this.pgPool) {
      this.pgPool = new PgPool({
        host: process.env.DB_HOST || "localhost",
        port: parseInt(process.env.DB_PORT || "5432", 10),
        user: process.env.DB_USER || "postgres",
        password:
          process.env.DB_PASSWORD ??
          (process.env.DB_ALLOW_EMPTY_PASSWORD === "true" ? "" : ""),
        database: process.env.DB_NAME || "postgres",
        ssl:
          process.env.DB_SSL === "true" || process.env.DB_SSL === "1"
            ? { rejectUnauthorized: false }
            : undefined,
      });
    }
    return this.pgPool;
  }

  private getSqliteDb(): Database.Database {
    if (!this.sqliteDb) {
      const file = getSqliteFile(this.cfg);
      this.sqliteDb = new Database(file);
    }
    return this.sqliteDb;
  }

  private async runQuery(
    text: string,
    values: unknown[]
  ): Promise<Record<string, unknown>[]> {
    const d = this.dialect;
    if (d === "sqlite") {
      const db = this.getSqliteDb();
      const stmt = db.prepare(text);
      if (values.length === 0) {
        return stmt.all() as Record<string, unknown>[];
      }
      return stmt.all(...values) as Record<string, unknown>[];
    }
    if (d === "mysql") {
      const pool = this.getMysqlPool();
      const [rows] = await pool.query(text, values);
      return rows as Record<string, unknown>[];
    }
    const pool = this.getPgPool();
    const res = await pool.query(text, values);
    return res.rows as Record<string, unknown>[];
  }

  /**
   * Run a scalar SELECT for a `query` variable. `{{token}}` placeholders are
   * rewritten to dialect-bound parameters (never string-interpolated), so
   * recipient data can't inject SQL. SELECT/WITH only, single statement.
   */
  async runScalarQuery(
    namedSql: string,
    bindings: Record<string, string>
  ): Promise<string | null> {
    const trimmed = namedSql.trim().replace(/;\s*$/, "");
    if (!/^(select|with)\b/i.test(trimmed)) {
      throw new Error("SQL variable must be a SELECT/WITH query");
    }
    if (trimmed.includes(";")) {
      throw new Error("SQL variable must be a single statement");
    }
    const values: unknown[] = [];
    const text = trimmed.replace(
      /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g,
      (_m, name: string) => {
        if (!(name in bindings)) {
          throw new Error(`unknown SQL token {{${name}}}`);
        }
        values.push(bindings[name]);
        return this.dialect === "postgres" ? `$${values.length}` : "?";
      }
    );
    const rows = await this.runQuery(text, values);
    const first = rows[0];
    if (!first) return null;
    const key = Object.keys(first)[0];
    if (key === undefined) return null;
    const v = first[key];
    return v === null || v === undefined ? null : String(v);
  }

  async lookupUsers(userIds: string[]): Promise<Map<string, UserRecord>> {
    const out = new Map<string, UserRecord>();
    if (userIds.length === 0) return out;

    const ul = this.cfg.user_lookup;
    const src = ul.source;
    if (!src) {
      throw new Error("user_lookup.source is required for SQL backends");
    }

    const fieldMap = ul.fields;
    const idType = getIdType(this.cfg);
    const dedupe = ul.batch?.dedupe !== false;
    const maxQ = ul.batch?.max_ids_per_query ?? 1000;

    const wireToCoerced = new Map<string, string>();
    const seen = new Set<string>();
    for (const w of userIds) {
      if (dedupe && seen.has(w)) continue;
      seen.add(w);
      const c = coerceIdForType(w, idType);
      if (c === null) {
        if (process.env.VITEST !== "true") {
          log.warn(
            `[UserLookup] Skipping invalid id for id_type=${idType}: ${JSON.stringify(w)}`
          );
        }
        continue;
      }
      wireToCoerced.set(w, c);
    }

    const uniqueCoerced = [...new Set(wireToCoerced.values())];
    const chunkSize = sqlChunkSize(this.dialect, maxQ);
    const byCoerced = new Map<string, Record<string, unknown>>();

    for (const chunk of chunkArray(uniqueCoerced, chunkSize)) {
      if (chunk.length === 0) continue;
      const { text, values } = buildSelectUsersQuery(
        this.dialect,
        src.name,
        src.id_column,
        fieldMap,
        chunk,
        idType as IdType
      );
      const rows = await this.runQuery(text, values);
      for (const row of rows) {
        const raw = row[src.id_column];
        const cell = raw === null || raw === undefined ? "" : String(raw).trim();
        const ck = coerceIdForType(cell, idType);
        if (ck !== null) {
          byCoerced.set(ck, row as Record<string, unknown>);
        }
      }
    }

    for (const [wire, coerced] of wireToCoerced) {
      const row = byCoerced.get(coerced);
      if (!row) continue;
      const u = mapSqlRowToUserRecord(wire, row, src.id_column, fieldMap, idType);
      if (u) out.set(wire, u);
    }

    if (process.env.VITEST !== "true") {
      log.info(
        `[UserLookup][${this.dialect}] Resolved ${out.size}/${userIds.length} users`
      );
    }
    return out;
  }
}
