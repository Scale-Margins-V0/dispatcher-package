/**
 * Convert a persisted `variables` row into the runtime PlaceholderEntry the
 * resolver/personalizer understands. Shared by the placeholder service and the
 * admin API so both interpret `config` identically.
 */

import type { ApiConfig, VariableRow } from "../db/schema/index.js";
import type { PlaceholderEntry } from "../user-lookup/config.js";
import { isValidResponsePath, primitiveFieldsOnly, type ResponseField } from "./api-response.js";
import { MAX_SAVED_PATHS } from "./api-config-schema.js";

function readApiConfig(config: Record<string, unknown> | null): ApiConfig {
  const cfg = (config ?? {}) as Partial<ApiConfig>;
  // Stored JSON is trusted only as far as its shape: anything malformed is
  // dropped rather than allowed to reach a request builder.
  const query = Array.isArray(cfg.query)
    ? cfg.query.filter(
        (q): q is { key: string; value: string } =>
          !!q && typeof q.key === "string" && q.key.length > 0 && typeof q.value === "string"
      )
    : [];
  // Rows stored before objects and arrays were excluded are dropped here, so
  // they are never offered as placeholders again.
  const schema = Array.isArray(cfg.response_schema)
    ? primitiveFieldsOnly(
        cfg.response_schema.filter(
          (f): f is ResponseField => !!f && typeof f.path === "string" && typeof f.type === "string"
        )
      )
    : [];
  // Same trust rule: a malformed or unknown-provider block saves nothing.
  const savedPaths = Array.isArray(cfg.save_response?.paths)
    ? cfg.save_response.paths.filter((p): p is string => typeof p === "string" && isValidResponsePath(p)).slice(0, MAX_SAVED_PATHS)
    : [];
  const saved =
    cfg.save_response?.provider === "freshchat" && savedPaths.length > 0
      ? { provider: "freshchat" as const, paths: savedPaths }
      : null;
  return {
    method: cfg.method === "POST" ? "POST" : "GET",
    url: typeof cfg.url === "string" ? cfg.url : "",
    ...(query.length ? { query } : {}),
    ...(cfg.headers && typeof cfg.headers === "object" ? { headers: cfg.headers } : {}),
    json_path: typeof cfg.json_path === "string" ? cfg.json_path : "",
    ...(typeof cfg.body === "string" ? { body: cfg.body } : {}),
    ...(typeof cfg.timeout_ms === "number" ? { timeout_ms: cfg.timeout_ms } : {}),
    ...(schema.length ? { response_schema: schema } : {}),
    ...(cfg.metadata && typeof cfg.metadata.id === "string"
      ? { metadata: { id: cfg.metadata.id, required: cfg.metadata.required !== false } }
      : {}),
    ...(saved ? { save_response: saved } : {}),
  };
}

export function rowToPlaceholderEntry(row: VariableRow): PlaceholderEntry {
  const fb = row.fallback !== null ? { fallback: row.fallback } : {};
  switch (row.source) {
    case "field":
      return { source: "field", field: row.field ?? "", ...fb };
    case "computed":
      return { source: "computed", expr: row.expr ?? "", ...fb };
    case "constant":
      return { source: "constant", value: String(row.config?.value ?? ""), ...fb };
    case "query":
      return { source: "query", sql: String(row.config?.sql ?? ""), ...fb };
    case "api":
      return { source: "api", api: readApiConfig(row.config), ...fb };
  }
}
