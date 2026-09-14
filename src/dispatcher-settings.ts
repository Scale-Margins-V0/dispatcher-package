/**
 * The `dispatcher:` block in `.env.yaml` — how this deployment is reached and
 * who may reach it.
 *
 *     dispatcher:
 *       port: 3100
 *       public_url: https://dispatcher.acme.example
 *       atlas_key: "…"            # or: atlas_key_env: DISPATCHER_ATLAS_KEY
 *       atlas_cors_origins: [https://atlas.scalemargin.com]
 *
 * Precedence is **per key**, and deliberately unlike `user_lookup.connection`,
 * which is per file. A connection is a set that must stay coherent — host from
 * one source and password from another connects somewhere nobody intended.
 * These four are independent scalars, so taking `port` from the environment
 * while `atlas_key` comes from YAML is ordinary, not a half-migration.
 *
 * The environment variables are NOT deprecated. Every existing deployment sets
 * them and keeps working untouched; this only adds a second place to say it.
 */

import { loadEnvYaml } from "./env-yaml.js";
import { DEFAULT_PORT, type DispatcherSettings } from "./dispatcher-schema.js";

export { DEFAULT_PORT, dispatcherSchema, type DispatcherSettings } from "./dispatcher-schema.js";

/** Where a resolved value came from, so warnings can name the right thing. */
export type SettingSource = "env.yaml" | "env";

function block(): DispatcherSettings | undefined {
  return loadEnvYaml().dispatcher;
}

/** The port to listen on. */
export function dispatcherPort(): number {
  const yamlPort = block()?.port;
  if (yamlPort !== undefined) return yamlPort;

  const raw = process.env.PORT?.trim();
  if (!raw) return DEFAULT_PORT;
  const parsed = Number.parseInt(raw, 10);
  // An unparseable PORT used to become NaN and take the process down at listen
  // time with no explanation. Fall back instead.
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : DEFAULT_PORT;
}

/**
 * The public origin, trailing slashes stripped. Null when unset — callers have
 * their own fallbacks and must keep them.
 */
export function dispatcherPublicUrl(): string | null {
  const fromYaml = block()?.public_url?.trim();
  if (fromYaml) return fromYaml.replace(/\/+$/, "");

  const fromEnv = process.env.DISPATCHER_PUBLIC_URL?.trim();
  return fromEnv ? fromEnv.replace(/\/+$/, "") : null;
}

/**
 * The Atlas credential, and where it came from.
 *
 * Null means the Atlas API is OFF. That is load-bearing: every data-plane route
 * fails closed on null, and it must never fall open because a lookup went wrong.
 */
export function resolveAtlasKey(): { value: string; source: SettingSource } | null {
  const cfg = block();

  const inline = cfg?.atlas_key?.trim();
  if (inline) return { value: inline, source: "env.yaml" };

  // A named variable is resolved here rather than at parse time, so a rotated
  // secret takes effect on restart without editing the YAML.
  const named = cfg?.atlas_key_env?.trim();
  if (named) {
    const referenced = process.env[named]?.trim();
    if (referenced) return { value: referenced, source: "env.yaml" };
    // Fall through: a dangling reference must not silently disable the API when
    // DISPATCHER_ATLAS_KEY is sitting right there. `atlasKeyWarning()` reports it.
  }

  const fromEnv = process.env.DISPATCHER_ATLAS_KEY?.trim();
  return fromEnv ? { value: fromEnv, source: "env" } : null;
}

/** Set when `atlas_key_env` names a variable that does not exist. */
export function danglingAtlasKeyRef(): string | null {
  const cfg = block();
  if (cfg?.atlas_key) return null;
  const named = cfg?.atlas_key_env?.trim();
  if (!named) return null;
  return process.env[named]?.trim() ? null : named;
}

/**
 * CORS origins as written, before normalization, plus their source. Returned
 * raw so the existing warning logic can still report unparseable entries by
 * count — normalizing first would silently drop them.
 */
export function resolveCorsOrigins(): { entries: string[]; source: SettingSource } | null {
  const configured = block()?.atlas_cors_origins;
  if (configured !== undefined) {
    const entries = Array.isArray(configured) ? configured : configured.split(",");
    // An explicit empty list means "no CORS", which is the safe default and not
    // worth warning about — distinct from the key being absent entirely.
    return { entries: entries.map((e) => e.trim()).filter(Boolean), source: "env.yaml" };
  }

  const raw = process.env.DISPATCHER_ATLAS_CORS_ORIGINS?.trim();
  if (!raw) return null;
  return { entries: raw.split(",").map((e) => e.trim()).filter(Boolean), source: "env" };
}

/** What to call the setting in a message, given where it was actually read from. */
export function settingName(key: keyof DispatcherSettings, source: SettingSource): string {
  if (source === "env.yaml") return `dispatcher.${key}`;
  const envNames: Record<string, string> = {
    port: "PORT",
    public_url: "DISPATCHER_PUBLIC_URL",
    atlas_key: "DISPATCHER_ATLAS_KEY",
    atlas_cors_origins: "DISPATCHER_ATLAS_CORS_ORIGINS",
  };
  return envNames[key] ?? String(key);
}
