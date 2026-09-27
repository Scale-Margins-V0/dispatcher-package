/**
 * SQLite table defs for the dispatcher state DB.
 * Keep column names/types in lockstep with mysql.ts and pg.ts — after any edit,
 * run `pnpm db:generate` to regenerate all three migration folders.
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const ts = (name: string) => integer(name, { mode: "timestamp_ms" });
const bool = (name: string) => integer(name, { mode: "boolean" });
const json = (name: string) => text(name, { mode: "json" });

export const variables = sqliteTable("variables", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  source: text("source").notNull(),
  field: text("field"),
  expr: text("expr"),
  fallback: text("fallback"),
  sample: text("sample"),
  config: json("config"),
  enabled: bool("enabled").notNull().default(true),
  created_at: ts("created_at").notNull(),
  updated_at: ts("updated_at").notNull(),
  updated_by: text("updated_by"),
});

/**
 * Call metadata schemas: a named set of keys (with a sample and an optional
 * validation regex each) an `api` variable can attach, making `{{key.k}}` /
 * `{{key.v}}` usable in its request. Definitions only — never a value.
 */
export const callMetadata = sqliteTable("call_metadata", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  /** [{ key, placeholder?, regex? }] */
  keys: json("keys").notNull(),
  created_at: ts("created_at").notNull(),
  updated_at: ts("updated_at").notNull(),
  updated_by: text("updated_by"),
});

export const dispatchRuns = sqliteTable(
  "dispatch_runs",
  {
    id: text("id").primaryKey(),
    campaign_id: text("campaign_id").notNull(),
    /** Grouping key: drip_sequence_id for drip steps, else campaign_id. */
    program_id: text("program_id").notNull().default(""),
    program_kind: text("program_kind").notNull().default("campaign"),
    step_id: text("step_id"),
    organization_id: text("organization_id"),
    channel: text("channel").notNull(),
    provider: text("provider").notNull(),
    status: text("status").notNull(),
    recipient_count: integer("recipient_count").notNull(),
    sent_count: integer("sent_count"),
    failed_count: integer("failed_count"),
    duration_ms: integer("duration_ms"),
    resolution_total: integer("resolution_total"),
    resolution_fallbacks: integer("resolution_fallbacks"),
    error_category: text("error_category"),
    error_message: text("error_message"),
    error_stack: text("error_stack"),
    occurred_at: ts("occurred_at").notNull(),
    updated_at: ts("updated_at").notNull(),
  },
  (t) => [
    index("dispatch_runs_occurred_at_idx").on(t.occurred_at),
    index("dispatch_runs_campaign_id_idx").on(t.campaign_id),
    index("dispatch_runs_program_idx").on(t.program_id, t.occurred_at),
  ]
);

export const dispatchRecipientFailures = sqliteTable(
  "dispatch_recipient_failures",
  {
    id: text("id").primaryKey(),
    dispatch_run_id: text("dispatch_run_id").notNull(),
    campaign_id: text("campaign_id").notNull(),
    user_id: text("user_id").notNull(),
    provider: text("provider").notNull(),
    error_category: text("error_category").notNull(),
    error_message: text("error_message").notNull(),
    error_stack: text("error_stack"),
    context: json("context"),
    occurred_at: ts("occurred_at").notNull(),
  },
  (t) => [
    index("recipient_failures_run_idx").on(t.dispatch_run_id),
    index("recipient_failures_occurred_at_idx").on(t.occurred_at),
  ]
);

export const webhookActivity = sqliteTable(
  "webhook_activity",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    direction: text("direction").notNull(),
    status: text("status").notNull(),
    event_count: integer("event_count").notNull(),
    http_status: integer("http_status"),
    duration_ms: integer("duration_ms"),
    attempt: integer("attempt"),
    destination: text("destination"),
    error_category: text("error_category"),
    error_message: text("error_message"),
    occurred_at: ts("occurred_at").notNull(),
  },
  (t) => [index("webhook_activity_occurred_at_idx").on(t.occurred_at)]
);

export const campaignCallbacks = sqliteTable("campaign_callbacks", {
  campaign_id: text("campaign_id").primaryKey(),
  organization_id: text("organization_id").notNull(),
  analytics_callback_url: text("analytics_callback_url").notNull(),
  created_at: ts("created_at").notNull(),
  last_used_at: ts("last_used_at").notNull(),
});

export const eventOutbox = sqliteTable(
  "event_outbox",
  {
    id: text("id").primaryKey(),
    callback_url: text("callback_url").notNull(),
    campaign_id: text("campaign_id").notNull(),
    organization_id: text("organization_id").notNull(),
    event: json("event").notNull(),
    idempotency_key: text("idempotency_key").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    next_attempt_at: ts("next_attempt_at").notNull(),
    last_error: text("last_error"),
    created_at: ts("created_at").notNull(),
    delivered_at: ts("delivered_at"),
  },
  (t) => [
    index("event_outbox_due_idx").on(t.status, t.next_attempt_at),
    index("event_outbox_idempotency_idx").on(t.idempotency_key),
  ]
);

/**
 * Wire campaign_id → program mapping, written on every dispatch.
 *
 * ScaleMargin sends drip steps with campaign_id = `drip_{enrollmentId}_{stepId}`,
 * which is unique per (sequence × lead × step) — so the wire id identifies a
 * single SEND, not a campaign. The real grouping key (drip_sequence_id) only
 * arrives in the dispatch metadata; inbound provider webhooks carry just the
 * wire id. This table lets those inbound events resolve their program.
 */
export const dispatchPrograms = sqliteTable(
  "dispatch_programs",
  {
    campaign_id: text("campaign_id").primaryKey(),
    program_id: text("program_id").notNull(),
    program_kind: text("program_kind").notNull().default("campaign"),
    step_id: text("step_id"),
    organization_id: text("organization_id").notNull(),
    created_at: ts("created_at").notNull(),
    last_seen_at: ts("last_seen_at").notNull(),
  },
  (t) => [index("dispatch_programs_program_idx").on(t.program_id)]
);

export const campaignEvents = sqliteTable(
  "campaign_events",
  {
    id: text("id").primaryKey(),
    /** The wire id — one SEND (for drips: one recipient × one step). */
    campaign_id: text("campaign_id").notNull(),
    /** The grouping key a human calls "the campaign": drip_sequence_id, else campaign_id. */
    program_id: text("program_id").notNull().default(""),
    program_kind: text("program_kind").notNull().default("campaign"),
    /** Drip step this send belongs to; null for one-shot campaigns. */
    step_id: text("step_id"),
    organization_id: text("organization_id").notNull(),
    user_id: text("user_id").notNull(),
    channel: text("channel").notNull(),
    event: text("event").notNull(),
    provider: text("provider").notNull(),
    provider_message_id: text("provider_message_id"),
    sender_id: text("sender_id"),
    occurred_at: ts("occurred_at").notNull(),
    received_at: ts("received_at").notNull(),
    metadata: json("metadata"),
    dedupe_key: text("dedupe_key").notNull(),
  },
  (t) => [
    index("campaign_events_campaign_occurred_idx").on(t.campaign_id, t.occurred_at),
    index("campaign_events_program_occurred_idx").on(t.program_id, t.occurred_at),
    index("campaign_events_program_user_idx").on(t.program_id, t.user_id),
    index("campaign_events_occurred_at_idx").on(t.occurred_at),
    uniqueIndex("campaign_events_dedupe_uq").on(t.dedupe_key),
  ]
);

export const appLogs = sqliteTable(
  "app_logs",
  {
    id: text("id").primaryKey(),
    ts: ts("ts").notNull(),
    level: text("level").notNull(),
    request_id: text("request_id"),
    campaign_id: text("campaign_id"),
    component: text("component"),
    message: text("message").notNull(),
    stack: text("stack"),
    context: json("context"),
  },
  (t) => [
    index("app_logs_ts_idx").on(t.ts),
    index("app_logs_level_idx").on(t.level),
    index("app_logs_campaign_id_idx").on(t.campaign_id),
  ]
);

export const devSentCampaigns = sqliteTable("dev_sent_campaigns", {
  campaign_id: text("campaign_id").primaryKey(),
  sent_at: ts("sent_at").notNull(),
});

export const dispatcherMeta = sqliteTable("dispatcher_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updated_at: ts("updated_at").notNull(),
});

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    key_hash: text("key_hash").notNull().unique(),
    key_ciphertext: text("key_ciphertext").notNull(),
    key_prefix: text("key_prefix").notNull(),
    created_at: ts("created_at").notNull(),
    updated_at: ts("updated_at").notNull(),
    last_used_at: ts("last_used_at"),
    revoked_at: ts("revoked_at"),
  },
  (t) => [
    index("api_keys_active_idx").on(t.revoked_at),
    index("api_keys_hash_idx").on(t.key_hash),
  ]
);

// ---------------------------------------------------------------------------
// Onsite activation subsystem (ScaleMargin cross-repo contract). A dispatch
// carries metadata.onsite with per-user assignments; each mints a random 256-bit
// sm_t token (stored only as a SHA-256 hash) embedded in the landing_url
// fragment. Redeeming binds the first visitor nonce, sets a __Host-sm_as session
// cookie, and returns the typed ScaleMargin envelope. The personalized decision
// is frozen (encrypted) per decision_id and reused across channels. Keep columns
// in lockstep with mysql.ts / pg.ts.
// ---------------------------------------------------------------------------

/** Frozen, encrypted decision snapshot — one row per decision_id, reused across
 * channels (email + WhatsApp) that share the same decision. */
export const onsiteDecisions = sqliteTable(
  "onsite_decisions",
  {
    decision_id: text("decision_id").primaryKey(),
    campaign_id: text("campaign_id").notNull(),
    program_id: text("program_id").notNull().default(""),
    program_kind: text("program_kind").notNull().default("campaign"),
    step_id: text("step_id"),
    organization_id: text("organization_id").notNull(),
    site_key: text("site_key").notNull(),
    /** AES-256-GCM ciphertext of the resolved, channel-independent envelope core. */
    snapshot_ciphertext: text("snapshot_ciphertext").notNull(),
    created_at: ts("created_at").notNull(),
    updated_at: ts("updated_at").notNull(),
  },
  (t) => [index("onsite_decisions_campaign_idx").on(t.campaign_id)]
);

/** Per-assignment activation: hashed sm_t token + the visitor nonce bound on
 * first redeem. One "touch" of a decision on a channel. */
export const onsiteActivations = sqliteTable(
  "onsite_activations",
  {
    id: text("id").primaryKey(),
    touch_id: text("touch_id").notNull(),
    decision_id: text("decision_id").notNull(),
    campaign_id: text("campaign_id").notNull(),
    program_id: text("program_id").notNull().default(""),
    program_kind: text("program_kind").notNull().default("campaign"),
    step_id: text("step_id"),
    organization_id: text("organization_id").notNull(),
    user_id: text("user_id").notNull(),
    channel: text("channel").notNull(),
    site_key: text("site_key").notNull(),
    placement: text("placement").notNull(),
    analytics_token: text("analytics_token").notNull(),
    offer_ref: text("offer_ref").notNull(),
    offer_version: text("offer_version").notNull(),
    /** SHA-256 hex of the 256-bit sm_t token carried in the landing_url fragment. */
    token_hash: text("token_hash").notNull(),
    /** SHA-256 hex of the first visitor nonce bound at redeem; null until then. */
    visitor_nonce_hash: text("visitor_nonce_hash"),
    status: text("status").notNull().default("issued"),
    starts_at: ts("starts_at").notNull(),
    expires_at: ts("expires_at").notNull(),
    issued_at: ts("issued_at").notNull(),
    bound_at: ts("bound_at"),
    created_at: ts("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("onsite_activations_token_uq").on(t.token_hash),
    index("onsite_activations_decision_idx").on(t.decision_id),
    index("onsite_activations_campaign_idx").on(t.campaign_id),
    index("onsite_activations_user_idx").on(t.user_id),
    index("onsite_activations_expires_idx").on(t.expires_at),
  ]
);

/** A redeemed session: hashed __Host-sm_as cookie, bound to the visitor nonce.
 * Enforces a 30m idle and 24h absolute lifetime. */
export const onsiteSessions = sqliteTable(
  "onsite_sessions",
  {
    id: text("id").primaryKey(),
    activation_id: text("activation_id").notNull(),
    decision_id: text("decision_id").notNull(),
    campaign_id: text("campaign_id").notNull(),
    organization_id: text("organization_id").notNull(),
    user_id: text("user_id").notNull(),
    /** SHA-256 hex of the opaque __Host-sm_as cookie value. */
    session_token_hash: text("session_token_hash").notNull(),
    /** SHA-256 hex of the bound visitor nonce. */
    nonce_hash: text("nonce_hash").notNull(),
    page_key: text("page_key").notNull(),
    consent_version: text("consent_version"),
    status: text("status").notNull().default("active"),
    created_at: ts("created_at").notNull(),
    /** Hard 24h ceiling. */
    absolute_expires_at: ts("absolute_expires_at").notNull(),
    /** Sliding 30m idle anchor; refreshed on each access. */
    last_seen_at: ts("last_seen_at").notNull(),
  },
  (t) => [
    uniqueIndex("onsite_sessions_token_uq").on(t.session_token_hash),
    index("onsite_sessions_activation_idx").on(t.activation_id),
    index("onsite_sessions_absolute_idx").on(t.absolute_expires_at),
  ]
);

/** Client-posted receipts (impression/click/dismiss); receipt_id is idempotent. */
export const onsiteReceipts = sqliteTable(
  "onsite_receipts",
  {
    id: text("id").primaryKey(),
    receipt_id: text("receipt_id").notNull(),
    activation_id: text("activation_id").notNull(),
    decision_id: text("decision_id").notNull(),
    session_id: text("session_id"),
    campaign_id: text("campaign_id").notNull(),
    organization_id: text("organization_id").notNull(),
    user_id: text("user_id").notNull(),
    type: text("type").notNull(),
    occurred_at: ts("occurred_at").notNull(),
    received_at: ts("received_at").notNull(),
  },
  (t) => [
    uniqueIndex("onsite_receipts_receipt_uq").on(t.receipt_id),
    index("onsite_receipts_activation_idx").on(t.activation_id),
    index("onsite_receipts_campaign_received_idx").on(
      t.campaign_id,
      t.received_at
    ),
  ]
);

// ---------------------------------------------------------------------------
// Better Auth tables (user/session/account/verification + organization plugin).
// JS property names MUST match Better Auth model field names; DB columns are
// snake_case. Keep in lockstep with mysql.ts / pg.ts.
// ---------------------------------------------------------------------------

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: bool("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role"),
  banned: bool("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: ts("ban_expires"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    token: text("token").notNull().unique(),
    expiresAt: ts("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    activeOrganizationId: text("active_organization_id"),
    impersonatedBy: text("impersonated_by"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)]
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)]
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)]
);

export const organization = sqliteTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: ts("created_at").notNull(),
});

export const member = sqliteTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("member"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("member_org_idx").on(t.organizationId)]
);

export const invitation = sqliteTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    expiresAt: ts("expires_at").notNull(),
    inviterId: text("inviter_id").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("invitation_org_idx").on(t.organizationId)]
);

export const dispatchSendLogs = sqliteTable(
  "dispatch_send_logs",
  {
    id: text("id").primaryKey(),
    dispatch_run_id: text("dispatch_run_id").notNull(),
    campaign_id: text("campaign_id").notNull(),
    program_id: text("program_id").notNull().default(""),
    step_id: text("step_id"),
    organization_id: text("organization_id"),
    user_id: text("user_id").notNull(),
    channel: text("channel").notNull(),
    provider: text("provider").notNull(),
    template_ref: text("template_ref"),
    status: text("status").notNull(),
    provider_message_id: text("provider_message_id"),
    latency_ms: integer("latency_ms"),
    error_category: text("error_category"),
    error_message: text("error_message"),
    fallbacks_used: integer("fallbacks_used"),
    occurred_at: ts("occurred_at").notNull(),
  },
  (t) => [
    index("send_logs_run_idx").on(t.dispatch_run_id),
    index("send_logs_program_occurred_idx").on(t.program_id, t.occurred_at),
    index("send_logs_program_user_idx").on(t.program_id, t.user_id),
    index("send_logs_occurred_at_idx").on(t.occurred_at),
  ]
);

export const campaignSummary = sqliteTable(
  "campaign_summary",
  {
    program_id: text("program_id").primaryKey(),
    program_kind: text("program_kind").notNull().default("campaign"),
    organization_id: text("organization_id"),
    channel: text("channel"),
    provider: text("provider"),
    template_ref: text("template_ref"),
    total_recipients: integer("total_recipients").notNull().default(0),
    sent: integer("sent").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    fallbacks_used: integer("fallbacks_used"),
    unique_recipients: integer("unique_recipients").notNull().default(0),
    dispatched: integer("dispatched").notNull().default(0),
    delivered: integer("delivered").notNull().default(0),
    opened: integer("opened").notNull().default(0),
    clicked: integer("clicked").notNull().default(0),
    bounced: integer("bounced").notNull().default(0),
    complained: integer("complained").notNull().default(0),
    unsubscribed: integer("unsubscribed").notNull().default(0),
    first_send_at: ts("first_send_at"),
    last_event_at: ts("last_event_at"),
    updated_at: ts("updated_at").notNull(),
  },
  (t) => [
    index("campaign_summary_org_idx").on(t.organization_id, t.last_event_at),
    index("campaign_summary_last_event_idx").on(t.last_event_at),
  ]
);

// ---------------------------------------------------------------------------
// Provider message ids. One row per accepted send, so the operator can look the
// id up in their own database and poll the provider for status themselves.
// Pruned by DISPATCHER_MESSAGE_ID_TTL (mandatory) in the hourly sweep.
// ---------------------------------------------------------------------------
export const providerMessageIds = sqliteTable(
  "provider_message_ids",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    provider_message_id: text("provider_message_id").notNull(),
    user_id: text("user_id").notNull(),
    sent_at: ts("sent_at").notNull(),
    // ── Delivery-status polling (Freshchat status_poller) ── all nullable:
    // rows from providers or senders that are not polled keep them empty.
    sender_id: text("sender_id"),
    status: text("status"),
    status_event: text("status_event"),
    status_at: ts("status_at"),
    provider_ref: text("provider_ref"),
    next_poll_at: ts("next_poll_at"),
    last_polled_at: ts("last_polled_at"),
    poll_attempts: integer("poll_attempts").notNull().default(0),
    poll_error: text("poll_error"),
  },
  (t) => [
    // The pruning sweep scans on this alone.
    index("provider_message_ids_sent_at_idx").on(t.sent_at),
    // The operator's own lookup path: "what is this id?".
    index("provider_message_ids_lookup_idx").on(t.provider, t.provider_message_id),
    // "Which messages did this user get?"
    index("provider_message_ids_user_idx").on(t.user_id),
    // "What is due?" — the poller's only query shape.
    index("provider_message_ids_poll_idx").on(t.provider, t.next_poll_at),
  ]
);

/**
 * Per-minute performance rollups (src/metrics/collector.ts): one row per
 * flush per (minute, program, step, kind, subject) — reads SUM them. No PII:
 * subjects are variable / provider / lookup-mode names, never user data.
 * Pruned after dispatcher.retention.metrics_days (default 7).
 */
export const dispatchMetrics = sqliteTable(
  "dispatch_metrics",
  {
    id: text("id").primaryKey(),
    /** Epoch minutes — integer so any bucket size is `minute - minute % n` in every dialect. */
    minute: integer("minute").notNull(),
    program_id: text("program_id").notNull(),
    step_id: text("step_id").notNull().default(""),
    kind: text("kind").notNull(),
    subject: text("subject").notNull().default(""),
    count: integer("count").notNull().default(0),
    ok: integer("ok").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    timeout: integer("timeout").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    fallback: integer("fallback").notNull().default(0),
    items: integer("items").notNull().default(0),
    sum_ms: integer("sum_ms").notNull().default(0),
    min_ms: integer("min_ms"),
    max_ms: integer("max_ms"),
    peak_per_sec: integer("peak_per_sec").notNull().default(0),
    /** Latency histogram — bounds in src/metrics/histogram.ts. */
    b0: integer("b0").notNull().default(0),
    b1: integer("b1").notNull().default(0),
    b2: integer("b2").notNull().default(0),
    b3: integer("b3").notNull().default(0),
    b4: integer("b4").notNull().default(0),
    b5: integer("b5").notNull().default(0),
    b6: integer("b6").notNull().default(0),
    b7: integer("b7").notNull().default(0),
    b8: integer("b8").notNull().default(0),
    b9: integer("b9").notNull().default(0),
    b10: integer("b10").notNull().default(0),
  },
  (t) => [
    index("dispatch_metrics_program_minute_idx").on(t.program_id, t.minute),
    index("dispatch_metrics_minute_idx").on(t.minute),
  ]
);
