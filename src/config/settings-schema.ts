/**
 * The `.env.yaml` blocks that replace `.env`.
 *
 * Pure schema, importing nothing but zod. `env-yaml.ts` needs these at
 * module-init time while the resolvers need `loadEnvYaml()`; one file would
 * make that a cycle and every schema would evaluate to `undefined`.
 *
 * Two kinds of block live here, and they nest differently:
 *
 *   - **System** — how the dispatcher itself runs: its own database, admin
 *     auth, retention, logging, telemetry. Nested under `dispatcher:` by
 *     dispatcher-schema.ts, so the file has one place for "this service".
 *   - **Feature** — what it does: platform credentials, links in messages,
 *     events, image storage. Top-level in env-yaml.ts.
 *
 * Every block and every key is optional. A deployment that sets nothing here
 * and passes real environment variables instead behaves exactly as it always
 * has — see `hydrate.ts` for the precedence rule.
 */

import { z } from "zod";

/** Accepts a YAML list or the comma-separated string someone pastes from .env. */
const listOrCsv = z.union([z.string(), z.array(z.string())]);

// ── ScaleMargin platform ─────────────────────────────────────────────────────
export const scalemarginSchema = z
  .object({
    dispatch_secret: z.string().min(1).optional(),
    dispatch_secret_env: z.string().min(1).optional(),
    analytics_secret: z.string().min(1).optional(),
    analytics_secret_env: z.string().min(1).optional(),
    analytics_callback_url: z.string().url().optional(),
  })
  .strict();

// ── dispatcher.database — the dispatcher's OWN database, never the customer one ─
export const stateDatabaseSchema = z
  .object({
    dialect: z.enum(["sqlite", "mysql", "postgres"]).optional(),
    /** Wins over the discrete fields below when set. */
    url: z.string().min(1).optional(),
    url_env: z.string().min(1).optional(),
    file: z.string().min(1).optional(), // sqlite only
    host: z.string().min(1).optional(),
    port: z.coerce.number().int().min(1).max(65535).optional(),
    user: z.string().min(1).optional(),
    password: z.string().optional(), // "" is a legitimate value
    password_env: z.string().min(1).optional(),
    database: z.string().min(1).optional(),
  })
  .strict();

// ── dispatcher.admin — console access and session security ────────────────────
export const adminSchema = z
  .object({
    email: z.string().email().optional(),
    password: z.string().min(1).optional(),
    password_env: z.string().min(1).optional(),
    /** Signs sessions. Generated and persisted if absent. */
    auth_secret: z.string().min(1).optional(),
    auth_secret_env: z.string().min(1).optional(),
    api_key_encryption_secret: z.string().min(1).optional(),
    api_key_encryption_secret_env: z.string().min(1).optional(),
    cookie_secure: z.boolean().optional(),
    trusted_origins: listOrCsv.optional(),
    /** Where a generated session secret is persisted. Default ./data/.better-auth-secret */
    auth_secret_file: z.string().min(1).optional(),
    /** Where the first-boot admin login is written. Default ./data/initial-admin-credentials.txt */
    credentials_file: z.string().min(1).optional(),
  })
  .strict();

// ── Links embedded in messages ───────────────────────────────────────────────
export const linksSchema = z
  .object({
    unsubscribe_url_base: z.string().url().optional(),
    unsubscribe_redirect_url: z.string().url().optional(),
    unsubscribe_analytics_url: z.string().url().optional(),
    preferences_redirect_url: z.string().url().optional(),
    /** Survey options on the unsubscribe page. */
    unsubscribe_reasons: listOrCsv.optional(),
    logo_url: z.string().url().optional(),
  })
  .strict();

// ── Inbound provider webhooks and outbound event forwarding ──────────────────
export const eventsSchema = z
  .object({
    forward_mode: z.string().min(1).optional(),
    delivery_mode: z.string().min(1).optional(),
    batch_size: z.coerce.number().int().positive().optional(),
    batch_interval_ms: z.coerce.number().int().positive().optional(),
    buffer_dir: z.string().min(1).optional(),
    providers_enabled: listOrCsv.optional(),
    providers_disabled: listOrCsv.optional(),
    sendgrid_inbound_events: listOrCsv.optional(),
    debug: z.boolean().optional(),
    /** Path to the events config file. Default ./config/events.yaml */
    config_path: z.string().min(1).optional(),
    /**
     * Turns on POST /api/scalemargin/client-events — your own systems reporting
     * events (clicked, read, …) for messages the dispatcher sent. Off (404)
     * until set. Sent as `Authorization: Bearer <secret>` or used to sign the
     * body (`X-ScaleMargin-Signature: sha256=<hmac>`).
     */
    client_webhook_secret: z.string().min(16, "client_webhook_secret must be at least 16 characters").optional(),
    client_webhook_secret_env: z.string().min(1).optional(),
  })
  .strict()
  .refine((e) => !(e.client_webhook_secret && e.client_webhook_secret_env), {
    message:
      "set client_webhook_secret or client_webhook_secret_env, not both — the inline value would win and the reference would be silently ignored",
    path: ["client_webhook_secret_env"],
  });

// ── Campaign image storage ───────────────────────────────────────────────────
export const storageSchema = z
  .object({
    provider: z.enum(["local", "s3", "gcs"]).optional(),
    cdn_base_url: z.string().url().optional(),
    local_dir: z.string().min(1).optional(),
    local_base_url: z.string().url().optional(),
    s3_bucket: z.string().min(1).optional(),
    s3_region: z.string().min(1).optional(),
    s3_prefix: z.string().optional(),
    gcs_bucket: z.string().min(1).optional(),
    gcs_project_id: z.string().min(1).optional(),
    gcs_prefix: z.string().optional(),
    gcs_credentials_json: z.string().min(1).optional(),
    gcs_credentials_json_env: z.string().min(1).optional(),
  })
  .strict();

// ── dispatcher.retention — how long the state database keeps things ──────────
export const retentionSchema = z
  .object({
    /**
     * How long provider message ids are kept, as a duration: "5d 2h", "12h".
     * MANDATORY — the dispatcher refuses to start without it, because the
     * alternative is quietly keeping ids forever. Minimum 1h; the sweep runs
     * hourly and cannot honour anything shorter. Parsed by config/duration.ts.
     */
    message_id_ttl: z.string().min(1).optional(),
    log_days: z.coerce.number().int().positive().optional(),
    log_max_rows: z.coerce.number().int().positive().optional(),
    campaign_event_days: z.coerce.number().int().positive().optional(),
    campaign_event_max_rows: z.coerce.number().int().positive().optional(),
    outbox_max_attempts: z.coerce.number().int().positive().optional(),
    /** Days of per-minute performance metrics to keep (default 7, max 30). */
    metrics_days: z.coerce.number().int().positive().max(30).optional(),
    /**
     * How long after sending a message the Freshchat status poller keeps
     * asking about it (a duration, e.g. "3d"). Default 3d; capped at
     * message_id_ttl, since the row is gone after that anyway.
     */
    freshchat_status_poll_ttl: z.string().min(1).optional(),
    /** Days onsite activations and sessions are kept past expiry (default 30). */
    onsite_days: z.coerce.number().int().positive().optional(),
  })
  .strict();

// ── dispatcher.onsite ─────────────────────────────────────────────────────────
/**
 * Onsite activation ({{onsite_url}} landing links). Off unless a state
 * encryption key is set: decision snapshots are only ever stored encrypted.
 */
export const onsiteSchema = z
  .object({
    // Shorter keys are treated as "not configured" by src/onsite/config.ts —
    // refuse them here rather than let onsite switch itself off silently.
    state_encryption_key: z
      .string()
      .refine((v) => Buffer.byteLength(v.trim(), "utf8") >= 32, "state_encryption_key must be at least 32 characters")
      .optional(),
    state_encryption_key_env: z.string().min(1).optional(),
  })
  .strict()
  .refine((o) => !(o.state_encryption_key && o.state_encryption_key_env), {
    message:
      "set state_encryption_key or state_encryption_key_env, not both — the inline value would win and the reference would be silently ignored",
    path: ["state_encryption_key_env"],
  });

// ── dispatcher.logging ──────────────────────────────────────────────────────────
export const loggingSchema = z
  .object({
    level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).optional(),
  })
  .strict();

// ── dispatcher.telemetry ────────────────────────────────────────────────────────
export const telemetrySchema = z
  .object({
    /** Product analytics for ScaleMargin. Opt out with `disabled: true`. */
    disabled: z.boolean().optional(),
    distinct_id: z.string().min(1).optional(),
    posthog_api_key: z.string().min(1).optional(),
    posthog_api_key_env: z.string().min(1).optional(),
    posthog_host: z.string().url().optional(),
  })
  .strict();

/**
 * Escape hatch: anything not modelled above, set verbatim.
 *
 * This is what makes "no `.env` file" achievable rather than aspirational —
 * a `_env:` reference elsewhere in this file needs its target to exist
 * somewhere, and without a `.env` the only remaining homes are the container's
 * `environment:` block or this map.
 *
 * Values are stringified, so `FLAG: true` and `COUNT: 3` behave as written.
 */
export const rawEnvSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a valid environment variable name"),
  z.union([z.string(), z.number(), z.boolean()])
);

export type ScaleMarginSettings = z.infer<typeof scalemarginSchema>;
export type StateDatabaseSettings = z.infer<typeof stateDatabaseSchema>;
export type AdminSettings = z.infer<typeof adminSchema>;
export type LinksSettings = z.infer<typeof linksSchema>;
export type EventsSettings = z.infer<typeof eventsSchema>;
export type StorageSettings = z.infer<typeof storageSchema>;
export type RetentionSettings = z.infer<typeof retentionSchema>;
export type LoggingSettings = z.infer<typeof loggingSchema>;
export type TelemetrySettings = z.infer<typeof telemetrySchema>;
export type RawEnvSettings = z.infer<typeof rawEnvSchema>;
