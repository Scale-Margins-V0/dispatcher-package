/**
 * Convert a persisted `variables` row into the runtime PlaceholderEntry the
 * resolver/personalizer understands. Shared by the placeholder service and the
 * admin API so both interpret `config` identically.
 */

import type { ApiConfig, VariableRow } from "../db/schema/index.js";
import type { PlaceholderEntry } from "../user-lookup/config.js";

function readApiConfig(config: Record<string, unknown> | null): ApiConfig {
  const cfg = (config ?? {}) as Partial<ApiConfig>;
  return {
    method: cfg.method === "POST" ? "POST" : "GET",
    url: typeof cfg.url === "string" ? cfg.url : "",
    ...(cfg.headers && typeof cfg.headers === "object" ? { headers: cfg.headers } : {}),
    json_path: typeof cfg.json_path === "string" ? cfg.json_path : "",
    ...(typeof cfg.body === "string" ? { body: cfg.body } : {}),
    ...(typeof cfg.timeout_ms === "number" ? { timeout_ms: cfg.timeout_ms } : {}),
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
