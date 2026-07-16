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
  config: json("config"),
  enabled: boolean("enabled").notNull().default(true),
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
  (t) => [index("api_keys_active_idx").on(t.revoked_at), index("api_keys_hash_idx").on(t.key_hash)]
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
