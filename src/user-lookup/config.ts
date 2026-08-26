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

/** Vitest sets `VITEST=true`; avoid noisy stderr for expected test paths. */
function isVitest(): boolean {
  return process.env.VITEST === "true";
}

const log = componentLogger(LogComponent.config);

const backendEnum = z.enum(["mysql", "postgres", "sqlite", "http", "mock"]);

const idTypeEnum = z.enum(["string", "int", "bigint", "uuid"]);

const apiConfigSchema = z.object({
  method: z.enum(["GET", "POST"]).default("GET"),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  json_path: z.string(),
  body: z.string().optional(),
  timeout_ms: z.number().int().positive().optional(),
});

const placeholderEntrySchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("field"),
    field: z.string(),
    fallback: z.string().optional(),
  }),
  z.object({
    source: z.literal("computed"),
    expr: z.string(),
    fallback: z.string().optional(),
  }),
  z.object({
    source: z.literal("constant"),
    value: z.string(),
    fallback: z.string().optional(),
  }),
  z.object({
    source: z.literal("query"),
    sql: z.string(),
    fallback: z.string().optional(),
  }),
  z.object({
    source: z.literal("api"),
    api: apiConfigSchema,
    fallback: z.string().optional(),
  }),
]);

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

export type DispatchConfig = z.infer<typeof dispatchConfigSchema>;
export type PlaceholderEntry = z.infer<typeof placeholderEntrySchema>;

export const DEFAULT_PLACEHOLDERS: Record<string, PlaceholderEntry> = {
  first_name: { source: "field", field: "first_name", fallback: "there" },
  last_name: { source: "field", field: "last_name", fallback: "" },
  full_name: {
    source: "computed",
    expr: "first_name + ' ' + last_name",
    fallback: "there",
  },
  company_name: { source: "field", field: "company_name", fallback: "" },
  email: { source: "field", field: "email", fallback: "" },
  unsubscribe_url: {
    source: "computed",
    expr: "env.UNSUBSCRIBE_URL_BASE + '?uid=' + user_id + '&campaign_id=' + campaign_id + '&organization_id=' + organization_id",
    fallback: "#",
  },
  preferences_url: {
    source: "computed",
    expr: "env.PREFERENCES_URL_BASE + '?uid=' + user_id + '&campaign_id=' + campaign_id + '&organization_id=' + organization_id",
    fallback: "#",
  },
};

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

/**
 * Load and validate dispatch config. Missing file → default mock + warn.
 * Invalid YAML when file exists → throws ZodError or YAMLException.
 */
export function loadDispatchConfigFromDisk(): DispatchConfig {
  const path = configPathFromEnv();
  cachedPath = path;

  if (!existsSync(path)) {
    log.warn(
      { path, error_category: "missing_config" },
      "No dispatch config found — falling back to the built-in MOCK user lookup, " +
        "which resolves fabricated recipients and never reads a real database"
    );
    cached = DEFAULT_DISPATCH_CONFIG;
    return applyBackendEnvOverride(cached);
  }

  const raw = readFileSync(path, "utf8");
  const parsed = parseDispatchYaml(raw);
  const validated = parseDispatchConfig(parsed);
  cached = validated;
  return applyBackendEnvOverride(cached);
}

export function getDispatchConfig(): DispatchConfig {
  if (!cached) {
    return loadDispatchConfigFromDisk();
  }
  return applyBackendEnvOverride(cached);
}

/** Re-parse after tests mutate env. */
export function reloadDispatchConfigForTests(): DispatchConfig {
  cached = null;
  return loadDispatchConfigFromDisk();
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

/**
 * Validates env for the active backend. Call once at process startup after secrets check.
 */
export function ensureDispatchConfigLoaded(): void {
  if (process.env.VITEST === "true" && !process.env.DB_HOST) {
    return;
  }
  const cfg = loadDispatchConfigFromDisk();
  const b = cfg.user_lookup.backend;

  if (b === "mysql" || b === "postgres") {
    requireEnv("DB_HOST");
    requireEnv("DB_NAME");
    requireEnv("DB_USER");
    const allowEmpty = process.env.DB_ALLOW_EMPTY_PASSWORD === "true";
    if (
      process.env.DB_PASSWORD === undefined &&
      !allowEmpty
    ) {
      throw new Error(
        "DB_PASSWORD is required for SQL backends (set DB_ALLOW_EMPTY_PASSWORD=true for empty password)"
      );
    }
  }

  if (b === "sqlite") {
    const file =
      cfg.user_lookup.sqlite?.file ||
      process.env.DB_FILE ||
      ":memory:";
    if (
      file !== ":memory:" &&
      !existsSync(file) &&
      process.env.VITEST !== "true"
    ) {
      log.warn(
        { path: file, error_category: "missing_database" },
        "Configured SQLite lookup database does not exist yet — it will be created on first write"
      );
    }
  }

  if (b === "http") {
    const http = cfg.user_lookup.http!;
    if (http.auth.type === "bearer" && http.auth.token_env) {
      if (!process.env[http.auth.token_env]) {
        throw new Error(
          `HTTP bearer auth requires ${http.auth.token_env} to be set in the environment`
        );
      }
    }
  }

  if (!cfg.user_lookup.fields.email) {
    log.warn(
      { error_category: "incomplete_field_map" },
      "user_lookup.fields has no `email` mapping — every recipient will be unresolvable " +
        "and no email can be addressed"
    );
  }
}

export function getPlaceholderRegistry(): Record<string, PlaceholderEntry> {
  // Once the state DB is bootstrapped, its variables table is the source of
  // truth (editable at runtime via the admin API). YAML/defaults remain the
  // fallback for processes that never init the DB (unit tests, tooling).
  return getPlaceholderSnapshot() ?? getDispatchConfig().placeholders;
}

export function getSqliteFile(config: DispatchConfig): string {
  return (
    config.user_lookup.sqlite?.file ||
    process.env.DB_FILE ||
    ":memory:"
  );
}

export function getIdType(config: DispatchConfig): IdType {
  return (config.user_lookup.source?.id_type ?? "string") as IdType;
}
