/**
 * One table mapping `.env.yaml` keys to the environment variable names the
 * rest of the codebase already reads.
 *
 * Why a table and not ~100 call-site edits: the dispatcher reads roughly a
 * hundred `process.env.X` sites across events, storage, auth, retention,
 * telemetry and the providers. Rewriting each one to consult YAML would be a
 * hundred chances to miss one, and a missed one fails silently — the setting
 * simply stops applying. Hydrating `process.env` from YAML at boot moves the
 * whole surface behind a single seam that can be tested on its own.
 *
 * Adding a setting means adding one row here and one key to the schema.
 * Nothing else changes.
 */

import type { EnvYaml } from "../env-yaml.js";

/** A value as it may appear in YAML, before being flattened to a string. */
type YamlValue = string | number | boolean | string[] | undefined;

export interface Binding {
  /** The environment variable the existing readers look for. */
  env: string;
  /** Pull the value out of the parsed file. */
  read: (cfg: EnvYaml) => YamlValue;
  /**
   * Names a variable holding the real value, rather than the value itself.
   * Set for `*_env` keys, which are dereferenced instead of copied.
   */
  indirect?: boolean;
}

type Block = Record<string, YamlValue> | undefined;

/**
 * One row per YAML key. `block` picks the object the keys live in, so a
 * top-level block and one nested under `dispatcher:` are bound the same way —
 * the table below reads as a map of the file, whatever the nesting.
 */
function bind(
  block: (cfg: EnvYaml) => unknown,
  rows: Array<[env: string, key: string, indirect?: boolean]>
): Binding[] {
  return rows.map(([env, key, indirect]) => ({
    env,
    indirect,
    read: (cfg) => (block(cfg) as Block)?.[key],
  }));
}

/**
 * Order matters only for readability — every binding targets a distinct
 * variable, and `hydrate()` never lets one overwrite another.
 */
export const BINDINGS: Binding[] = [
  // ── This deployment's identity and access ─────────────────────────────────
  ...bind((c) => c.dispatcher, [
    ["PORT", "port"],
    ["DISPATCHER_PUBLIC_URL", "public_url"],
    ["DISPATCHER_ATLAS_KEY", "atlas_key"],
    ["DISPATCHER_ATLAS_KEY", "atlas_key_env", true],
    ["DISPATCHER_ATLAS_CORS_ORIGINS", "atlas_cors_origins"],
    ["DISPATCHER_LOGS_API_TOKEN", "logs_api_token"],
    ["DISPATCHER_LOGS_API_TOKEN", "logs_api_token_env", true],
  ]),

  // ── ScaleMargin platform ──────────────────────────────────────────────────
  ...bind((c) => c.scalemargin, [
    ["SCALEMARGIN_DISPATCH_SECRET", "dispatch_secret"],
    ["SCALEMARGIN_DISPATCH_SECRET", "dispatch_secret_env", true],
    ["SCALEMARGIN_ANALYTICS_SECRET", "analytics_secret"],
    ["SCALEMARGIN_ANALYTICS_SECRET", "analytics_secret_env", true],
    ["SCALEMARGIN_ANALYTICS_CALLBACK_URL", "analytics_callback_url"],
  ]),

  // ── dispatcher.database — its own state database ──────────────────────────
  ...bind((c) => c.dispatcher?.database, [
    ["DISPATCHER_DB_DIALECT", "dialect"],
    ["DISPATCHER_DB_URL", "url"],
    ["DISPATCHER_DB_URL", "url_env", true],
    // sqlite takes a path; resolveDbEnv() reads it out of DISPATCHER_DB_URL.
    ["DISPATCHER_DB_URL", "file"],
    ["DISPATCHER_DB_HOST", "host"],
    ["DISPATCHER_DB_PORT", "port"],
    ["DISPATCHER_DB_USER", "user"],
    ["DISPATCHER_DB_PASSWORD", "password"],
    ["DISPATCHER_DB_PASSWORD", "password_env", true],
    ["DISPATCHER_DB_NAME", "database"],
  ]),

  // ── dispatcher.admin — console access and session security ────────────────
  ...bind((c) => c.dispatcher?.admin, [
    ["DISPATCHER_ADMIN_EMAIL", "email"],
    ["DISPATCHER_ADMIN_PASSWORD", "password"],
    ["DISPATCHER_ADMIN_PASSWORD", "password_env", true],
    ["BETTER_AUTH_SECRET", "auth_secret"],
    ["BETTER_AUTH_SECRET", "auth_secret_env", true],
    ["DISPATCHER_API_KEY_ENCRYPTION_SECRET", "api_key_encryption_secret"],
    ["DISPATCHER_API_KEY_ENCRYPTION_SECRET", "api_key_encryption_secret_env", true],
    ["DISPATCHER_ADMIN_COOKIE_SECURE", "cookie_secure"],
    ["DISPATCHER_TRUSTED_ORIGINS", "trusted_origins"],
    ["DISPATCHER_AUTH_SECRET_FILE", "auth_secret_file"],
    ["DISPATCHER_ADMIN_CREDENTIALS_FILE", "credentials_file"],
  ]),

  // ── Single-sender shorthand ───────────────────────────────────────────────
  ...bind((c) => c.email, [
    ["EMAIL_PROVIDER", "provider"],
    ["FROM_EMAIL", "from"],
    ["REPLY_TO_EMAIL", "reply_to"],
  ]),

  // ── Links inside messages ─────────────────────────────────────────────────
  ...bind((c) => c.links, [
    ["UNSUBSCRIBE_URL_BASE", "unsubscribe_url_base"],
    ["UNSUBSCRIBE_LINK_REDIRECT_URL", "unsubscribe_redirect_url"],
    ["UNSUBSCRIBE_LINK_ANALYTICS_URL", "unsubscribe_analytics_url"],
    ["PREFERENCES_LINK_REDIRECT_URL", "preferences_redirect_url"],
    ["UNSUBSCRIBE_REASONS", "unsubscribe_reasons"],
    ["LOGO_URL", "logo_url"],
  ]),

  // ── Event pipeline ────────────────────────────────────────────────────────
  ...bind((c) => c.events, [
    ["EVENT_FORWARD_MODE", "forward_mode"],
    ["EVENT_DELIVERY_MODE", "delivery_mode"],
    ["EVENT_BATCH_SIZE", "batch_size"],
    ["EVENT_BATCH_INTERVAL_MS", "batch_interval_ms"],
    ["EVENT_BUFFER_DIR", "buffer_dir"],
    ["EVENT_PROVIDERS_ENABLED", "providers_enabled"],
    ["EVENT_PROVIDERS_DISABLED", "providers_disabled"],
    ["EVENT_SENDGRID_INBOUND_EVENTS", "sendgrid_inbound_events"],
    ["EVENT_DEBUG", "debug"],
    ["EVENTS_CONFIG_PATH", "config_path"],
  ]),

  // ── Campaign image storage ────────────────────────────────────────────────
  ...bind((c) => c.storage, [
    ["IMAGE_STORAGE_PROVIDER", "provider"],
    ["IMAGE_CDN_BASE_URL", "cdn_base_url"],
    ["IMAGE_LOCAL_DIR", "local_dir"],
    ["IMAGE_LOCAL_BASE_URL", "local_base_url"],
    ["IMAGE_S3_BUCKET", "s3_bucket"],
    ["IMAGE_S3_REGION", "s3_region"],
    ["IMAGE_S3_PREFIX", "s3_prefix"],
    ["IMAGE_GCS_BUCKET", "gcs_bucket"],
    ["IMAGE_GCS_PROJECT_ID", "gcs_project_id"],
    ["IMAGE_GCS_PREFIX", "gcs_prefix"],
    ["IMAGE_GCS_CREDENTIALS_JSON", "gcs_credentials_json"],
    ["IMAGE_GCS_CREDENTIALS_JSON", "gcs_credentials_json_env", true],
  ]),

  // ── dispatcher.retention ──────────────────────────────────────────────────
  ...bind((c) => c.dispatcher?.retention, [
    ["DISPATCHER_MESSAGE_ID_TTL", "message_id_ttl"],
    ["DISPATCHER_LOG_RETENTION_DAYS", "log_days"],
    ["DISPATCHER_LOG_MAX_ROWS", "log_max_rows"],
    ["DISPATCHER_CAMPAIGN_EVENTS_RETENTION_DAYS", "campaign_event_days"],
    ["DISPATCHER_CAMPAIGN_EVENTS_MAX_ROWS", "campaign_event_max_rows"],
    ["DISPATCHER_OUTBOX_MAX_ATTEMPTS", "outbox_max_attempts"],
  ]),

  ...bind((c) => c.dispatcher?.logging, [["DISPATCHER_LOG_LEVEL", "level"]]),

  ...bind((c) => c.dispatcher?.telemetry, [
    ["DISPATCHER_TELEMETRY_DISABLED", "disabled"],
    ["DISPATCHER_TELEMETRY_DISTINCT_ID", "distinct_id"],
    ["POSTHOG_API_KEY", "posthog_api_key"],
    ["POSTHOG_API_KEY", "posthog_api_key_env", true],
    ["POSTHOG_HOST", "posthog_host"],
  ]),
];

/**
 * Settings that can NEVER come from `.env.yaml`, and why.
 *
 * Exported so the schema test can assert none of them creeps into BINDINGS —
 * a binding for any of these would be quietly ineffective, which is worse than
 * absent because the operator would believe it took effect.
 */
export const ENV_ONLY: ReadonlyArray<readonly [string, string]> = [
  ["ENV_YAML_PATH", "points AT this file — reading it from inside would be circular"],
  ["NODE_ENV", "set by the runtime, not the deployment"],
  ["VITEST", "set by the test runner"],
  ["LOCAL_DEV", "a launch mode, deliberately awkward to enable in a committed file"],
  ["DISPATCHER_VERSION", "baked in at image build time"],
  ["DISPATCHER_GIT_SHA", "baked in at image build time"],
  ["DISPATCHER_BUILD_TIME", "baked in at image build time"],
  ["DISPATCHER_IMAGE_TAG", "baked in at image build time"],
];
