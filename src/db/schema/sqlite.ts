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
  (t) => [index("api_keys_active_idx").on(t.revoked_at), index("api_keys_hash_idx").on(t.key_hash)]
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
