/**
 * Where the customer-database credentials come from.
 *
 * `.env.yaml` `user_lookup.connection` wins; `DB_*` remains a warned fallback
 * for the length of the deprecation window, so an operator can move their
 * config and their credentials in separate steps.
 *
 * One resolver, used by both the boot check and the SQL adapter — two copies of
 * this precedence would drift, and the failure would be a dispatcher connecting
 * to the wrong database rather than an error.
 */

import { componentLogger } from "../logging/logger.js";
import { LogComponent } from "../logging/conventions.js";
import type { LookupConnection } from "./schema.js";

const log = componentLogger(LogComponent.config);

export type SqlBackend = "mysql" | "postgres" | "sqlite";

export type ResolvedConnection = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
  /** Which precedence step supplied the values — surfaced in diagnostics. */
  from: "env.yaml" | "env";
};

const DEFAULTS = {
  mysql: { port: 3306, user: "root", database: "mysql" },
  postgres: { port: 5432, user: "postgres", database: "postgres" },
  sqlite: { port: 0, user: "", database: "" },
} as const;

function isTruthy(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

/** `password` inline wins over `password_env`, matching the sender convention. */
function passwordFrom(conn: LookupConnection): string | undefined {
  if (conn.password !== undefined) return conn.password;
  return conn.password_env ? process.env[conn.password_env] : undefined;
}

let envFallbackWarned = false;

function warnEnvFallback(): void {
  if (envFallbackWarned) return;
  envFallbackWarned = true;
  log.warn(
    { error_category: "deprecated_config" },
    "Customer database credentials came from DB_* environment variables — move them " +
      "under `user_lookup.connection` in .env.yaml. DB_* support will be removed in a future release"
  );
}

export function resetConnectionWarningForTests(): void {
  envFallbackWarned = false;
}

export function resolveConnection(
  backend: SqlBackend,
  conn: LookupConnection | undefined
): ResolvedConnection {
  const d = DEFAULTS[backend];
  const inline = conn && Object.keys(conn).length > 0;

  if (inline) {
    return {
      host: conn.host ?? "localhost",
      port: conn.port ?? d.port,
      user: conn.user ?? d.user,
      password: passwordFrom(conn) ?? "",
      database: conn.database ?? d.database,
      ssl: conn.ssl ?? false,
      from: "env.yaml",
    };
  }

  warnEnvFallback();
  return {
    host: process.env.DB_HOST ?? "localhost",
    port: process.env.DB_PORT ? Number.parseInt(process.env.DB_PORT, 10) : d.port,
    user: process.env.DB_USER ?? d.user,
    password: process.env.DB_PASSWORD ?? "",
    database: process.env.DB_NAME ?? d.database,
    ssl: isTruthy(process.env.DB_SSL),
    from: "env",
  };
}

/**
 * What is missing before this connection can be opened. Empty means usable.
 *
 * Returned rather than thrown so the caller decides severity: boot fails hard,
 * diagnostics only reports.
 */
export function missingConnectionFields(
  backend: SqlBackend,
  resolved: ResolvedConnection,
  conn: LookupConnection | undefined
): string[] {
  if (backend === "sqlite") return [];

  const inline = resolved.from === "env.yaml";
  const missing: string[] = [];
  const need = (ok: boolean, yamlKey: string, envKey: string) => {
    if (!ok) missing.push(inline ? `user_lookup.connection.${yamlKey}` : envKey);
  };

  need(Boolean(inline ? conn?.host : process.env.DB_HOST), "host", "DB_HOST");
  need(Boolean(inline ? conn?.user : process.env.DB_USER), "user", "DB_USER");
  need(Boolean(inline ? conn?.database : process.env.DB_NAME), "database", "DB_NAME");

  // An inline `password: ""` is explicit and needs no escape hatch; the env
  // path keeps DB_ALLOW_EMPTY_PASSWORD because an unset variable is ambiguous.
  const passwordGiven = inline
    ? conn?.password !== undefined || Boolean(conn?.password_env)
    : process.env.DB_PASSWORD !== undefined ||
      isTruthy(process.env.DB_ALLOW_EMPTY_PASSWORD);
  need(passwordGiven, "password", "DB_PASSWORD");

  return missing;
}
