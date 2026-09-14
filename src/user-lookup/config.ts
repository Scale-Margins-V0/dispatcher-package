/**
 * `dispatch.yaml` → Zod `DispatchConfig`, optional `USER_LOOKUP_BACKEND` override, placeholders.
 * Call `ensureDispatchConfigLoaded()` at startup so SQL/HTTP backends fail fast on missing env.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { componentLogger } from "../logging/logger.js";
import { LogComponent } from "../logging/conventions.js";
import { getPlaceholderSnapshot } from "../variables/service.js";
import type { IdType } from "./mapper.js";
import { DEFAULT_PLACEHOLDERS, placeholderEntrySchema } from "./placeholders.js";
import type { PlaceholderEntry } from "./placeholders.js";
import { dispatchConfigFromEnvYaml } from "./from-env-yaml.js";
import { loadEnvYaml } from "../env-yaml.js";
import type { LookupConnection, NetworkLookupYaml } from "./schema.js";
import { missingConnectionFields, resolveConnection } from "./connection.js";

/** Vitest sets `VITEST=true`; avoid noisy stderr for expected test paths. */
function isVitest(): boolean {
  return process.env.VITEST === "true";
}

const log = componentLogger(LogComponent.config);

const backendEnum = z.enum(["mysql", "postgres", "sqlite", "http", "mock"]);

const idTypeEnum = z.enum(["string", "int", "bigint", "uuid"]);

const userLookupSchema = z
  .object({
    backend: backendEnum,
    source: z
      .object({
        kind: z.enum(["table", "view"]).default("table"),
        name: z.string(),
        id_column: z.string(),
        id_type: idTypeEnum.default("string"),
      })
      .optional(),
    sqlite: z
      .object({
        file: z.string(),
      })
      .optional(),
    fields: z.record(z.string(), z.string()),
    http: z
      .object({
        base_url: z.string().url(),
        path: z.string().refine((p) => p.startsWith("/"), "path must start with /"),
        method: z.enum(["GET", "POST", "PUT"]).default("POST"),
        auth: z
          .object({
            type: z.enum(["bearer", "header", "none"]).default("none"),
            token_env: z.string().optional(),
            header_name: z.string().optional(),
          })
          .default({ type: "none" }),
        request: z.object({ id_field: z.string() }),
        response: z.object({
          root: z.string().optional(),
          id_field: z.string(),
        }),
        timeout_ms: z.number().int().positive().default(3000),
        retries: z.number().int().min(0).max(5).default(2),
      })
      .optional(),
    batch: z
      .object({
        max_ids_per_query: z.number().int().positive().max(10_000).default(1000),
        dedupe: z.boolean().default(true),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.backend === "http") {
      if (!data.http) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "user_lookup.http is required when backend is http",
          path: ["http"],
        });
      } else if (data.http.auth.type === "bearer") {
        if (!data.http.auth.token_env) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "http.auth.token_env is required for bearer auth",
            path: ["http", "auth", "token_env"],
          });
        }
      }
    }
    if (data.backend === "mysql" || data.backend === "postgres") {
      if (!data.source) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `user_lookup.source is required when backend is ${data.backend}`,
          path: ["source"],
        });
      }
    }
    if (data.backend === "sqlite") {
      if (!data.source) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "user_lookup.source is required when backend is sqlite",
          path: ["source"],
        });
      }
    }
  });

export const dispatchConfigSchema = z.object({
  user_lookup: userLookupSchema,
  placeholders: z.record(z.string(), placeholderEntrySchema),
});

export type DispatchConfig = z.infer<typeof dispatchConfigSchema> & {
  user_lookup: {
    /** Inline customer-DB credentials from .env.yaml. Absent → fall back to DB_*. */
    connection?: LookupConnection;
    /** Network-mode endpoint from .env.yaml. */
    network?: NetworkLookupYaml["network"];
  };
};

// Re-exported so the four modules importing these from here keep working.
export {
  DEFAULT_PLACEHOLDERS,
  placeholderEntrySchema,
  VARIABLE_SOURCES,
  SQL_ONLY_VARIABLE_SOURCES,
} from "./placeholders.js";
export type { PlaceholderEntry } from "./placeholders.js";

export const DEFAULT_DISPATCH_CONFIG: DispatchConfig = {
  user_lookup: {
    backend: "mock",
    fields: {
      first_name: "first_name",
      last_name: "last_name",
      email: "email",
      phone: "phone",
      company_name: "company_name",
    },
    batch: { max_ids_per_query: 1000, dedupe: true },
  },
  placeholders: DEFAULT_PLACEHOLDERS,
};

let cached: DispatchConfig | null = null;
let cachedPath: string | null = null;

export function resetDispatchConfigForTests(): void {
  cached = null;
  cachedPath = null;
  deprecationWarned = false;
}

/** Test helper: inject a parsed config without reading disk. */
export function setDispatchConfigForTests(cfg: DispatchConfig): void {
  cached = cfg;
}

export function configPathFromEnv(): string {
  const p = process.env.USER_LOOKUP_CONFIG_PATH || "./config/dispatch.yaml";
  return resolve(process.cwd(), p);
}

export function parseDispatchYaml(raw: string): unknown {
  return yaml.load(raw);
}

export function parseDispatchConfig(data: unknown): DispatchConfig {
  return dispatchConfigSchema.parse(data);
}

function applyBackendEnvOverride(config: DispatchConfig): DispatchConfig {
  const override = process.env.USER_LOOKUP_BACKEND;
  if (!override) return config;
  const b = backendEnum.safeParse(override);
  if (!b.success) {
    log.warn(
      { value: override, error_category: "invalid_env" },
      "Ignoring USER_LOOKUP_BACKEND — not a supported backend"
    );
    return config;
  }
  return {
    ...config,
    user_lookup: { ...config.user_lookup, backend: b.data },
  };
}

/** Warned once per process, not once per dispatch. */
let deprecationWarned = false;

function warnDispatchYamlDeprecated(path: string): void {
  if (deprecationWarned) return;
  deprecationWarned = true;
  log.warn(
    { path, error_category: "deprecated_config" },
    "Reading user lookup from config/dispatch.yaml — move it under `user_lookup:` in " +
      ".env.yaml. Support for this file will be removed in a future release"
  );
}

function fromDispatchYaml(): DispatchConfig | null {
  const path = configPathFromEnv();
  cachedPath = path;
  if (!existsSync(path)) return null;

  const validated = parseDispatchConfig(parseDispatchYaml(readFileSync(path, "utf8")));
  warnDispatchYamlDeprecated(path);
  return validated;
}

function fromEnvYaml(): DispatchConfig | null {
  const lookup = loadEnvYaml().user_lookup;
  return lookup ? dispatchConfigFromEnvYaml(lookup) : null;
}

/**
 * Precedence is per file, never per key: a merged half-migration is harder to
 * debug than either whole config.
 *
 *   .env.yaml `user_lookup:`  →  config/dispatch.yaml  →  mock
 */
export function loadDispatchConfig(): DispatchConfig {
  const resolved = fromEnvYaml() ?? fromDispatchYaml();

  if (!resolved) {
    log.warn(
      { path: cachedPath, error_category: "missing_config" },
      // Keep the phrase "MOCK user lookup" — every runbook greps for it.
      "No user lookup configured — falling back to the built-in MOCK user lookup, " +
        "which resolves fabricated recipients and never reads a real database"
    );
    cached = DEFAULT_DISPATCH_CONFIG;
    return applyBackendEnvOverride(cached);
  }

  cached = resolved;
  return applyBackendEnvOverride(cached);
}

/** @deprecated Use loadDispatchConfig(). Kept so existing call sites compile. */
export const loadDispatchConfigFromDisk = loadDispatchConfig;

export function getDispatchConfig(): DispatchConfig {
  if (!cached) {
    return loadDispatchConfig();
  }
  return applyBackendEnvOverride(cached);
}

/** Re-parse after tests mutate env. */
export function reloadDispatchConfigForTests(): DispatchConfig {
  cached = null;
  deprecationWarned = false;
  return loadDispatchConfig();
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * Validates env for the active backend. Call once at process startup after secrets check.
 */
export function ensureDispatchConfigLoaded(): void {
  if (isVitest() && !process.env.DB_HOST) return;

  const cfg = loadDispatchConfig();
  const backend = cfg.user_lookup.backend;

  if (backend === "mysql" || backend === "postgres" || backend === "sqlite") {
    const resolved = resolveConnection(backend, cfg.user_lookup.connection);
    const missing = missingConnectionFields(backend, resolved, cfg.user_lookup.connection);
    if (missing.length > 0) {
      throw new Error(
        `Customer database is not fully configured — missing: ${missing.join(", ")}`
      );
    }
    const sqliteFile = getSqliteFile(cfg);
    if (backend === "sqlite" && sqliteFile !== ":memory:" && !existsSync(sqliteFile) && !isVitest()) {
      log.warn(
        { path: sqliteFile, error_category: "missing_database" },
        "Configured SQLite lookup database does not exist yet — it will be created on first write"
      );
    }
  }

  if (backend === "http") {
    requireNetworkToken(cfg);
  }

  if (!cfg.user_lookup.fields.email) {
    log.warn(
      { error_category: "incomplete_field_map" },
      "user_lookup.fields has no `email` mapping — every recipient will be unresolvable " +
        "and no email can be addressed"
    );
  }
}

/**
 * Network mode: the token may be inline or named by `token_env`. A named
 * variable that is not set is a boot failure, not a runtime 401.
 */
function requireNetworkToken(cfg: DispatchConfig): void {
  const network = cfg.user_lookup.network;
  if (!network) {
    // dispatch.yaml's http backend carries its own auth block; it validates itself.
    const http = cfg.user_lookup.http;
    if (http?.auth.type === "bearer" && http.auth.token_env) {
      requireEnv(http.auth.token_env);
    }
    return;
  }
  if (network.token) return;
  if (network.token_env) requireEnv(network.token_env);
}

export function getPlaceholderRegistry(): Record<string, PlaceholderEntry> {
  // Once the state DB is bootstrapped, its variables table is the source of
  // truth (editable at runtime via the admin API). YAML/defaults remain the
  // fallback for processes that never init the DB (unit tests, tooling).
  return getPlaceholderSnapshot() ?? getDispatchConfig().placeholders;
}

export function getSqliteFile(config: DispatchConfig): string {
  return (
    // .env.yaml `user_lookup.connection.file`, then dispatch.yaml's
    // `user_lookup.sqlite.file`, then the env fallback.
    config.user_lookup.connection?.file ||
    config.user_lookup.sqlite?.file ||
    process.env.DB_FILE ||
    ":memory:"
  );
}

export function getIdType(config: DispatchConfig): IdType {
  return (config.user_lookup.source?.id_type ?? "string") as IdType;
}
