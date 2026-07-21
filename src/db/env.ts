/**
 * DISPATCHER_DB_* env resolution for the dispatcher's own state database.
 * Deliberately a separate namespace from the client-DB DB_* vars used by user-lookup.
 */

export type DispatcherDbDialect = "sqlite" | "mysql" | "postgres";

export type DispatcherDbEnv =
  | { dialect: "sqlite"; file: string }
  | {
      dialect: "mysql" | "postgres";
      /** Full connection URL; wins over discrete settings when set. */
      url: string | null;
      host: string;
      port: number;
      user: string;
      password: string;
      database: string;
    };

const DIALECTS: DispatcherDbDialect[] = ["sqlite", "mysql", "postgres"];

export const DEFAULT_SQLITE_FILE = "./data/dispatcher.db";

function sqliteFileFromUrl(url: string): string {
  if (url.startsWith("file:")) return url.slice("file:".length) || ":memory:";
  return url;
}

export function resolveDbEnv(env: NodeJS.ProcessEnv = process.env): DispatcherDbEnv {
  const rawDialect = env.DISPATCHER_DB_DIALECT?.trim().toLowerCase();
  const dialect = (rawDialect || "sqlite") as DispatcherDbDialect;
  if (!DIALECTS.includes(dialect)) {
    throw new Error(
      `Invalid DISPATCHER_DB_DIALECT=${JSON.stringify(rawDialect)} — expected one of: ${DIALECTS.join(", ")}`
    );
  }

  if (dialect === "sqlite") {
    const url = env.DISPATCHER_DB_URL?.trim();
    if (url) return { dialect, file: sqliteFileFromUrl(url) };
    // Hermetic default under vitest so specs never touch the working tree.
    if (env.VITEST === "true") return { dialect, file: ":memory:" };
    return { dialect, file: DEFAULT_SQLITE_FILE };
  }

  const url = env.DISPATCHER_DB_URL?.trim() || null;
  const host = env.DISPATCHER_DB_HOST?.trim();
  if (!url && !host) {
    throw new Error(
      `DISPATCHER_DB_DIALECT=${dialect} requires DISPATCHER_DB_URL or DISPATCHER_DB_HOST/PORT/USER/PASSWORD/NAME`
    );
  }
  return {
    dialect,
    url,
    host: host || "localhost",
    port: parseInt(env.DISPATCHER_DB_PORT || (dialect === "mysql" ? "3306" : "5432"), 10),
    user: env.DISPATCHER_DB_USER || (dialect === "mysql" ? "root" : "postgres"),
    password: env.DISPATCHER_DB_PASSWORD ?? "",
    database: env.DISPATCHER_DB_NAME || "dispatcher_state",
  };
}
