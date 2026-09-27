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
  buildColumnProbeQuery,
  buildSelectUsersQuery,
  sqlChunkSize,
  type SqlDialect,
} from "../sql-build.js";
import { CONTACT_FIELD_NAMES, fieldsForChannel, type LookupChannel } from "../channel.js";
import { referencedFieldNames } from "../field-refs.js";
import { getPlaceholderRegistry } from "../config.js";
import { validateSafeIdentifier } from "../mapper.js";
import type { UserLookupAdapter, UserRecord } from "../types.js";
import { resolveConnection, type ResolvedConnection } from "../connection.js";

const log = componentLogger("user-lookup.sql");

/** Columns change when someone alters the view, not per send. */
const COLUMNS_TTL_MS = 5 * 60 * 1000;

export class SqlAdapter implements UserLookupAdapter {
  private mysqlPool: MysqlPool | null = null;
  private pgPool: PgPool | null = null;
  private sqliteDb: Database.Database | null = null;
  private resolved: ResolvedConnection | null = null;
  private columnsCache: { at: number; columns: string[] } | null = null;
  private warnedMissing = new Set<string>();

  constructor(private readonly cfg: DispatchConfig) {}

  /**
   * `.env.yaml` `user_lookup.connection` when present, else `DB_*`. Resolved
   * once per adapter so the two precedence paths cannot diverge between pools.
   */
  private get connection(): ResolvedConnection {
    this.resolved ??= resolveConnection(this.dialect, this.cfg.user_lookup.connection);
    return this.resolved;
  }

  private get dialect(): SqlDialect {
    const b = this.cfg.user_lookup.backend;
    if (b === "mysql" || b === "postgres" || b === "sqlite") return b;
    throw new Error(`SqlAdapter used with backend ${b}`);
  }

  private getMysqlPool(): MysqlPool {
    if (!this.mysqlPool) {
      const { host, port, user, password, database } = this.connection;
      this.mysqlPool = createPool({
        host,
        port,
        user,
        password,
        database,
        waitForConnections: true,
        connectionLimit: 10,
      });
    }
    return this.mysqlPool;
  }

  private getPgPool(): PgPool {
    if (!this.pgPool) {
      const { host, port, user, password, database, ssl } = this.connection;
      this.pgPool = new PgPool({
        host,
        port,
        user,
        password,
        database,
        ssl: ssl ? { rejectUnauthorized: false } : undefined,
      });
    }
    return this.pgPool;
  }

  private getSqliteDb(): Database.Database {
    if (!this.sqliteDb) {
      this.sqliteDb = new Database(getSqliteFile(this.cfg));
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

  /** Every column of the source view, as the database reports it. Cached briefly. */
  async listSourceColumns(): Promise<string[]> {
    if (this.columnsCache && Date.now() - this.columnsCache.at < COLUMNS_TTL_MS) {
      return this.columnsCache.columns;
    }
    const src = this.cfg.user_lookup.source;
    if (!src) throw new Error("user_lookup.source is required for SQL backends");
    const text = buildColumnProbeQuery(this.dialect, src.name);
    let columns: string[];
    if (this.dialect === "sqlite") {
      columns = this.getSqliteDb().prepare(text).columns().map((c) => c.name);
    } else if (this.dialect === "mysql") {
      const [, fields] = await this.getMysqlPool().query(text);
      columns = (fields as Array<{ name: string }>).map((f) => f.name);
    } else {
      columns = (await this.getPgPool().query(text)).fields.map((f) => f.name);
    }
    this.columnsCache = { at: Date.now(), columns };
    return columns;
  }

  /**
   * The extra columns enabled variables read, as logical name → column.
   *
   * A name the view does not have is skipped with one warning, never selected:
   * one unknown column would fail the whole query and resolve nobody. A
   * leftover non-contact key in `fields:` still aliases a name to a column, so
   * a variable written against the old mapping keeps working.
   */
  private async variableColumns(): Promise<Record<string, string>> {
    const ul = this.cfg.user_lookup;
    const refs = referencedFieldNames(getPlaceholderRegistry()).filter(
      (name) => !CONTACT_FIELD_NAMES.has(name)
    );
    if (refs.length === 0) return {};

    const available = new Set(await this.listSourceColumns());
    const out: Record<string, string> = {};
    for (const name of refs) {
      const column = ul.fields[name] ?? name;
      if (validateSafeIdentifier(column) && available.has(column)) {
        out[name] = column;
      } else if (!this.warnedMissing.has(column)) {
        this.warnedMissing.add(column);
        log.warn(
          { column, source: ul.source?.name, error_category: "unknown_column" },
          `A variable reads column "${column}", which ${ul.source?.name} does not have — its fallback is used`
        );
      }
    }
    return out;
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

  async lookupUsers(
    userIds: string[],
    channel: LookupChannel = "email"
  ): Promise<Map<string, UserRecord>> {
    const out = new Map<string, UserRecord>();
    if (userIds.length === 0) return out;

    const ul = this.cfg.user_lookup;
    const src = ul.source;
    if (!src) {
      throw new Error("user_lookup.source is required for SQL backends");
    }

    // Contact field for this channel, plus only the columns variables read.
    const fieldMap = {
      ...(await this.variableColumns()),
      ...fieldsForChannel(ul.fields, channel),
    };
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
      const u = mapSqlRowToUserRecord(wire, row, src.id_column, fieldMap, idType, channel);
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
