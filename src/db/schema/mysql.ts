/**
 * MySQL table defs for the dispatcher state DB.
 * Keep column names/types in lockstep with sqlite.ts and pg.ts — after any edit,
 * run `pnpm db:generate` to regenerate all three migration folders.
 * Unique/indexed varchars stay ≤191 chars for utf8mb4 index safety.
 */

import {
  boolean,
  index,
  int,
  json,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

const ts = (name: string) => timestamp(name, { mode: "date", fsp: 3 });
const id191 = (name: string) => varchar(name, { length: 191 });

export const variables = mysqlTable("variables", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: id191("name").notNull().unique(),
  source: varchar("source", { length: 16 }).notNull(),
  field: id191("field"),
  expr: text("expr"),
  fallback: text("fallback"),
  sample: text("sample"),
  config: json("config"),
  enabled: boolean("enabled").notNull().default(true),
  created_at: ts("created_at").notNull(),
  updated_at: ts("updated_at").notNull(),
  updated_by: id191("updated_by"),
});

/**
 * Call metadata schemas: a named set of keys (with a sample and an optional
 * validation regex each) an `api` variable can attach, making `{{key.k}}` /
 * `{{key.v}}` usable in its request. Definitions only — never a value.
 */
export const callMetadata = mysqlTable("call_metadata", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: id191("name").notNull().unique(),
  /** [{ key, placeholder?, regex? }] */
  keys: json("keys").notNull(),
  created_at: ts("created_at").notNull(),
  updated_at: ts("updated_at").notNull(),
  updated_by: id191("updated_by"),
});

export const dispatchRuns = mysqlTable(
  "dispatch_runs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    campaign_id: id191("campaign_id").notNull(),
    /** Grouping key: drip_sequence_id for drip steps, else campaign_id. */
    program_id: id191("program_id").notNull().default(""),
    program_kind: varchar("program_kind", { length: 16 }).notNull().default("campaign"),
    step_id: id191("step_id"),
    organization_id: id191("organization_id"),
    channel: varchar("channel", { length: 32 }).notNull(),
    provider: varchar("provider", { length: 32 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    recipient_count: int("recipient_count").notNull(),
    sent_count: int("sent_count"),
    failed_count: int("failed_count"),
    duration_ms: int("duration_ms"),
    resolution_total: int("resolution_total"),
    resolution_fallbacks: int("resolution_fallbacks"),
    error_category: id191("error_category"),
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

export const dispatchRecipientFailures = mysqlTable(
  "dispatch_recipient_failures",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    dispatch_run_id: varchar("dispatch_run_id", { length: 36 }).notNull(),
    campaign_id: id191("campaign_id").notNull(),
    user_id: id191("user_id").notNull(),
    provider: varchar("provider", { length: 32 }).notNull(),
    error_category: id191("error_category").notNull(),
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

export const webhookActivity = mysqlTable(
  "webhook_activity",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    provider: varchar("provider", { length: 32 }).notNull(),
    direction: varchar("direction", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    event_count: int("event_count").notNull(),
    http_status: int("http_status"),
    duration_ms: int("duration_ms"),
    attempt: int("attempt"),
    destination: text("destination"),
    error_category: id191("error_category"),
    error_message: text("error_message"),
    occurred_at: ts("occurred_at").notNull(),
  },
  (t) => [index("webhook_activity_occurred_at_idx").on(t.occurred_at)]
);

export const campaignCallbacks = mysqlTable("campaign_callbacks", {
  campaign_id: id191("campaign_id").primaryKey(),
  organization_id: id191("organization_id").notNull(),
  analytics_callback_url: text("analytics_callback_url").notNull(),
  created_at: ts("created_at").notNull(),
  last_used_at: ts("last_used_at").notNull(),
});

export const eventOutbox = mysqlTable(
  "event_outbox",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    callback_url: text("callback_url").notNull(),
    campaign_id: id191("campaign_id").notNull(),
    organization_id: id191("organization_id").notNull(),
    event: json("event").notNull(),
    idempotency_key: varchar("idempotency_key", { length: 64 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    attempts: int("attempts").notNull().default(0),
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
export const dispatchPrograms = mysqlTable(
  "dispatch_programs",
  {
    campaign_id: id191("campaign_id").primaryKey(),
    program_id: id191("program_id").notNull(),
    program_kind: varchar("program_kind", { length: 16 }).notNull().default("campaign"),
    step_id: id191("step_id"),
    organization_id: id191("organization_id").notNull(),
    created_at: ts("created_at").notNull(),
    last_seen_at: ts("last_seen_at").notNull(),
  },
  (t) => [index("dispatch_programs_program_idx").on(t.program_id)]
);

export const campaignEvents = mysqlTable(
  "campaign_events",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    /** The wire id — one SEND (for drips: one recipient × one step). */
    campaign_id: id191("campaign_id").notNull(),
    /** The grouping key a human calls "the campaign": drip_sequence_id, else campaign_id. */
    program_id: id191("program_id").notNull().default(""),
    program_kind: varchar("program_kind", { length: 16 }).notNull().default("campaign"),
    /** Drip step this send belongs to; null for one-shot campaigns. */
    step_id: id191("step_id"),
    organization_id: id191("organization_id").notNull(),
    user_id: id191("user_id").notNull(),
    channel: varchar("channel", { length: 16 }).notNull(),
    event: varchar("event", { length: 24 }).notNull(),
    provider: varchar("provider", { length: 32 }).notNull(),
    provider_message_id: id191("provider_message_id"),
    sender_id: id191("sender_id"),
    occurred_at: ts("occurred_at").notNull(),
    received_at: ts("received_at").notNull(),
    metadata: json("metadata"),
    dedupe_key: varchar("dedupe_key", { length: 64 }).notNull(),
  },
  (t) => [
    index("campaign_events_campaign_occurred_idx").on(t.campaign_id, t.occurred_at),
    index("campaign_events_program_occurred_idx").on(t.program_id, t.occurred_at),
    index("campaign_events_program_user_idx").on(t.program_id, t.user_id),
    index("campaign_events_occurred_at_idx").on(t.occurred_at),
    uniqueIndex("campaign_events_dedupe_uq").on(t.dedupe_key),
  ]
);

export const appLogs = mysqlTable(
  "app_logs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    ts: ts("ts").notNull(),
    level: varchar("level", { length: 8 }).notNull(),
    request_id: varchar("request_id", { length: 36 }),
    campaign_id: id191("campaign_id"),
    component: varchar("component", { length: 64 }),
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

export const devSentCampaigns = mysqlTable("dev_sent_campaigns", {
  campaign_id: id191("campaign_id").primaryKey(),
  sent_at: ts("sent_at").notNull(),
});

export const dispatcherMeta = mysqlTable("dispatcher_meta", {
  key: id191("key").primaryKey(),
  value: text("value").notNull(),
  updated_at: ts("updated_at").notNull(),
});

export const apiKeys = mysqlTable(
  "api_keys",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    name: id191("name").notNull().unique(),
    key_hash: varchar("key_hash", { length: 64 }).notNull().unique(),
    key_ciphertext: text("key_ciphertext").notNull(),
    key_prefix: varchar("key_prefix", { length: 16 }).notNull(),
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
// Onsite activation subsystem (ScaleMargin cross-repo contract). See sqlite.ts
// for design notes. Decision snapshots stored encrypted; sm_t tokens, visitor
// nonces and session cookies stored as SHA-256 hashes (64 hex chars). Keep in
// lockstep with sqlite.ts / pg.ts.
// ---------------------------------------------------------------------------

const hash64 = (name: string) => varchar(name, { length: 64 });

export const onsiteDecisions = mysqlTable(
  "onsite_decisions",
  {
    decision_id: id191("decision_id").primaryKey(),
    campaign_id: id191("campaign_id").notNull(),
    program_id: id191("program_id").notNull().default(""),
    program_kind: varchar("program_kind", { length: 16 })
      .notNull()
      .default("campaign"),
    step_id: id191("step_id"),
    organization_id: id191("organization_id").notNull(),
    site_key: id191("site_key").notNull(),
    snapshot_ciphertext: text("snapshot_ciphertext").notNull(),
    created_at: ts("created_at").notNull(),
    updated_at: ts("updated_at").notNull(),
  },
  (t) => [index("onsite_decisions_campaign_idx").on(t.campaign_id)]
);

export const onsiteActivations = mysqlTable(
  "onsite_activations",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    touch_id: varchar("touch_id", { length: 36 }).notNull(),
    decision_id: id191("decision_id").notNull(),
    campaign_id: id191("campaign_id").notNull(),
    program_id: id191("program_id").notNull().default(""),
    program_kind: varchar("program_kind", { length: 16 })
      .notNull()
      .default("campaign"),
    step_id: id191("step_id"),
    organization_id: id191("organization_id").notNull(),
    user_id: id191("user_id").notNull(),
    channel: varchar("channel", { length: 16 }).notNull(),
    site_key: id191("site_key").notNull(),
    placement: id191("placement").notNull(),
    analytics_token: text("analytics_token").notNull(),
    offer_ref: id191("offer_ref").notNull(),
    offer_version: varchar("offer_version", { length: 64 }).notNull(),
    token_hash: hash64("token_hash").notNull(),
    visitor_nonce_hash: hash64("visitor_nonce_hash"),
    status: varchar("status", { length: 16 }).notNull().default("issued"),
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

export const onsiteSessions = mysqlTable(
  "onsite_sessions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    activation_id: varchar("activation_id", { length: 36 }).notNull(),
    decision_id: id191("decision_id").notNull(),
    campaign_id: id191("campaign_id").notNull(),
    organization_id: id191("organization_id").notNull(),
    user_id: id191("user_id").notNull(),
    session_token_hash: hash64("session_token_hash").notNull(),
    nonce_hash: hash64("nonce_hash").notNull(),
    page_key: id191("page_key").notNull(),
    consent_version: varchar("consent_version", { length: 64 }),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    created_at: ts("created_at").notNull(),
    absolute_expires_at: ts("absolute_expires_at").notNull(),
    last_seen_at: ts("last_seen_at").notNull(),
  },
  (t) => [
    uniqueIndex("onsite_sessions_token_uq").on(t.session_token_hash),
    index("onsite_sessions_activation_idx").on(t.activation_id),
    index("onsite_sessions_absolute_idx").on(t.absolute_expires_at),
  ]
);

export const onsiteReceipts = mysqlTable(
  "onsite_receipts",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    receipt_id: id191("receipt_id").notNull(),
    activation_id: varchar("activation_id", { length: 36 }).notNull(),
    decision_id: id191("decision_id").notNull(),
    session_id: varchar("session_id", { length: 36 }),
    campaign_id: id191("campaign_id").notNull(),
    organization_id: id191("organization_id").notNull(),
    user_id: id191("user_id").notNull(),
    type: varchar("type", { length: 24 }).notNull(),
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
// Better Auth tables. JS property names match Better Auth model fields; DB
// columns snake_case. Unique columns capped at 191 for utf8mb4 index safety.
// Keep in lockstep with sqlite.ts / pg.ts.
// ---------------------------------------------------------------------------

const authId = (name: string) => varchar(name, { length: 255 });

export const user = mysqlTable("user", {
  id: authId("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  email: id191("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: varchar("role", { length: 64 }),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: ts("ban_expires"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const session = mysqlTable(
  "session",
  {
    id: authId("id").primaryKey(),
    userId: authId("user_id").notNull(),
    token: id191("token").notNull().unique(),
    expiresAt: ts("expires_at").notNull(),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: text("user_agent"),
    activeOrganizationId: authId("active_organization_id"),
    impersonatedBy: authId("impersonated_by"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)]
);

export const account = mysqlTable(
  "account",
  {
    id: authId("id").primaryKey(),
    userId: authId("user_id").notNull(),
    accountId: authId("account_id").notNull(),
    providerId: varchar("provider_id", { length: 128 }).notNull(),
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

export const verification = mysqlTable(
  "verification",
  {
    id: authId("id").primaryKey(),
    identifier: id191("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)]
);

export const organization = mysqlTable("organization", {
  id: authId("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: id191("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: ts("created_at").notNull(),
});

export const member = mysqlTable(
  "member",
  {
    id: authId("id").primaryKey(),
    organizationId: authId("organization_id").notNull(),
    userId: authId("user_id").notNull(),
    role: varchar("role", { length: 64 }).notNull().default("member"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("member_org_idx").on(t.organizationId)]
);

export const invitation = mysqlTable(
  "invitation",
  {
    id: authId("id").primaryKey(),
    organizationId: authId("organization_id").notNull(),
    email: id191("email").notNull(),
    role: varchar("role", { length: 64 }),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    expiresAt: ts("expires_at").notNull(),
    inviterId: authId("inviter_id").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("invitation_org_idx").on(t.organizationId)]
);

export const dispatchSendLogs = mysqlTable(
  "dispatch_send_logs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    dispatch_run_id: varchar("dispatch_run_id", { length: 36 }).notNull(),
    campaign_id: id191("campaign_id").notNull(),
    program_id: id191("program_id").notNull().default(""),
    step_id: id191("step_id"),
    organization_id: id191("organization_id"),
    user_id: id191("user_id").notNull(),
    channel: varchar("channel", { length: 16 }).notNull(),
    provider: varchar("provider", { length: 32 }).notNull(),
    template_ref: id191("template_ref"),
    status: varchar("status", { length: 16 }).notNull(),
    provider_message_id: id191("provider_message_id"),
    latency_ms: int("latency_ms"),
    error_category: id191("error_category"),
    error_message: text("error_message"),
    fallbacks_used: int("fallbacks_used"),
    occurred_at: ts("occurred_at").notNull(),
  },
  (t) => [
    index("send_logs_run_idx").on(t.dispatch_run_id),
    index("send_logs_program_occurred_idx").on(t.program_id, t.occurred_at),
    index("send_logs_program_user_idx").on(t.program_id, t.user_id),
    index("send_logs_occurred_at_idx").on(t.occurred_at),
  ]
);

export const campaignSummary = mysqlTable(
  "campaign_summary",
  {
    program_id: id191("program_id").primaryKey(),
    program_kind: varchar("program_kind", { length: 16 }).notNull().default("campaign"),
    organization_id: id191("organization_id"),
    channel: varchar("channel", { length: 16 }),
    provider: varchar("provider", { length: 32 }),
    template_ref: id191("template_ref"),
    total_recipients: int("total_recipients").notNull().default(0),
    sent: int("sent").notNull().default(0),
    failed: int("failed").notNull().default(0),
    fallbacks_used: int("fallbacks_used"),
    unique_recipients: int("unique_recipients").notNull().default(0),
    dispatched: int("dispatched").notNull().default(0),
    delivered: int("delivered").notNull().default(0),
    opened: int("opened").notNull().default(0),
    clicked: int("clicked").notNull().default(0),
    bounced: int("bounced").notNull().default(0),
    complained: int("complained").notNull().default(0),
    unsubscribed: int("unsubscribed").notNull().default(0),
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
export const providerMessageIds = mysqlTable(
  "provider_message_ids",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    provider: varchar("provider", { length: 32 }).notNull(),
    provider_message_id: id191("provider_message_id").notNull(),
    user_id: id191("user_id").notNull(),
    sent_at: ts("sent_at").notNull(),
    // ── Delivery-status polling (Freshchat status_poller) ── all nullable:
    // rows from providers or senders that are not polled keep them empty.
    sender_id: id191("sender_id"),
    status: varchar("status", { length: 32 }),
    status_event: varchar("status_event", { length: 16 }),
    status_at: ts("status_at"),
    provider_ref: id191("provider_ref"),
    next_poll_at: ts("next_poll_at"),
    last_polled_at: ts("last_polled_at"),
    poll_attempts: int("poll_attempts").notNull().default(0),
    poll_error: varchar("poll_error", { length: 255 }),
  },
  (t) => [
    index("provider_message_ids_sent_at_idx").on(t.sent_at),
    index("provider_message_ids_lookup_idx").on(t.provider, t.provider_message_id),
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
export const dispatchMetrics = mysqlTable(
  "dispatch_metrics",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    /** Epoch minutes — integer so any bucket size is `minute - minute % n` in every dialect. */
    minute: int("minute").notNull(),
    program_id: id191("program_id").notNull(),
    step_id: id191("step_id").notNull().default(""),
    kind: varchar("kind", { length: 24 }).notNull(),
    subject: id191("subject").notNull().default(""),
    count: int("count").notNull().default(0),
    ok: int("ok").notNull().default(0),
    failed: int("failed").notNull().default(0),
    timeout: int("timeout").notNull().default(0),
    skipped: int("skipped").notNull().default(0),
    fallback: int("fallback").notNull().default(0),
    items: int("items").notNull().default(0),
    sum_ms: int("sum_ms").notNull().default(0),
    min_ms: int("min_ms"),
    max_ms: int("max_ms"),
    peak_per_sec: int("peak_per_sec").notNull().default(0),
    /** Latency histogram — bounds in src/metrics/histogram.ts. */
    b0: int("b0").notNull().default(0),
    b1: int("b1").notNull().default(0),
    b2: int("b2").notNull().default(0),
    b3: int("b3").notNull().default(0),
    b4: int("b4").notNull().default(0),
    b5: int("b5").notNull().default(0),
    b6: int("b6").notNull().default(0),
    b7: int("b7").notNull().default(0),
    b8: int("b8").notNull().default(0),
    b9: int("b9").notNull().default(0),
    b10: int("b10").notNull().default(0),
  },
  (t) => [
    index("dispatch_metrics_program_minute_idx").on(t.program_id, t.minute),
    index("dispatch_metrics_minute_idx").on(t.minute),
  ]
);

/**
 * Values picked out of an API variable's response (its `save_response` paths),
 * saved against the message they were sent with. One row per value, so a value
 * can be looked up directly ("which message carried offer OF-123?"). Only
 * written when the message was accepted by the provider the variable names
 * (Freshchat), never for a fallback. Pruned with provider_message_ids, on
 * dispatcher.retention.message_id_ttl.
 */
export const apiResponseRefs = mysqlTable(
  "api_response_refs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    provider: varchar("provider", { length: 32 }).notNull(),
    provider_message_id: id191("provider_message_id").notNull(),
    channel: varchar("channel", { length: 16 }).notNull(),
    user_id: id191("user_id").notNull(),
    organization_id: id191("organization_id"),
    campaign_id: id191("campaign_id").notNull(),
    dispatch_id: id191("dispatch_id"),
    template_name: id191("template_name"),
    sender_id: id191("sender_id"),
    variable_name: id191("variable_name").notNull(),
    path: id191("path").notNull(),
    value: id191("value").notNull(),
    sent_at: ts("sent_at").notNull(),
  },
  (t) => [
    // "What was saved for this message?"
    index("api_response_refs_message_idx").on(t.provider, t.provider_message_id),
    // "Which message carried this value?" — the reason this is a table of rows.
    index("api_response_refs_value_idx").on(t.variable_name, t.path, t.value),
    index("api_response_refs_campaign_idx").on(t.campaign_id),
    // The pruning sweep.
    index("api_response_refs_sent_at_idx").on(t.sent_at),
  ]
);
