/**
 * PostgreSQL table defs for the dispatcher state DB.
 * Keep column names/types in lockstep with sqlite.ts and mysql.ts — after any edit,
 * run `pnpm db:generate` to regenerate all three migration folders.
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const id191 = (name: string) => varchar(name, { length: 191 });

export const variables = pgTable("variables", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: id191("name").notNull().unique(),
  source: varchar("source", { length: 16 }).notNull(),
  field: id191("field"),
  expr: text("expr"),
  fallback: text("fallback"),
  enabled: boolean("enabled").notNull().default(true),
  created_at: ts("created_at").notNull(),
  updated_at: ts("updated_at").notNull(),
  updated_by: id191("updated_by"),
});

export const dispatchRuns = pgTable(
  "dispatch_runs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    campaign_id: id191("campaign_id").notNull(),
    organization_id: id191("organization_id"),
    channel: varchar("channel", { length: 32 }).notNull(),
    provider: varchar("provider", { length: 32 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    recipient_count: integer("recipient_count").notNull(),
    sent_count: integer("sent_count"),
    failed_count: integer("failed_count"),
    duration_ms: integer("duration_ms"),
    error_category: id191("error_category"),
    error_message: text("error_message"),
    error_stack: text("error_stack"),
    occurred_at: ts("occurred_at").notNull(),
    updated_at: ts("updated_at").notNull(),
  },
  (t) => [
    index("dispatch_runs_occurred_at_idx").on(t.occurred_at),
    index("dispatch_runs_campaign_id_idx").on(t.campaign_id),
  ]
);

export const dispatchRecipientFailures = pgTable(
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
    context: jsonb("context"),
    occurred_at: ts("occurred_at").notNull(),
  },
  (t) => [
    index("recipient_failures_run_idx").on(t.dispatch_run_id),
    index("recipient_failures_occurred_at_idx").on(t.occurred_at),
  ]
);

export const webhookActivity = pgTable(
  "webhook_activity",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    provider: varchar("provider", { length: 32 }).notNull(),
    direction: varchar("direction", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    event_count: integer("event_count").notNull(),
    http_status: integer("http_status"),
    duration_ms: integer("duration_ms"),
    attempt: integer("attempt"),
    destination: text("destination"),
    error_category: id191("error_category"),
    error_message: text("error_message"),
    occurred_at: ts("occurred_at").notNull(),
  },
  (t) => [index("webhook_activity_occurred_at_idx").on(t.occurred_at)]
);

export const campaignCallbacks = pgTable("campaign_callbacks", {
  campaign_id: id191("campaign_id").primaryKey(),
  organization_id: id191("organization_id").notNull(),
  analytics_callback_url: text("analytics_callback_url").notNull(),
  created_at: ts("created_at").notNull(),
  last_used_at: ts("last_used_at").notNull(),
});

export const eventOutbox = pgTable(
  "event_outbox",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    callback_url: text("callback_url").notNull(),
    campaign_id: id191("campaign_id").notNull(),
    organization_id: id191("organization_id").notNull(),
    event: jsonb("event").notNull(),
    idempotency_key: varchar("idempotency_key", { length: 64 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
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

export const appLogs = pgTable(
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
    context: jsonb("context"),
  },
  (t) => [
    index("app_logs_ts_idx").on(t.ts),
    index("app_logs_level_idx").on(t.level),
    index("app_logs_campaign_id_idx").on(t.campaign_id),
  ]
);

export const devSentCampaigns = pgTable("dev_sent_campaigns", {
  campaign_id: id191("campaign_id").primaryKey(),
  sent_at: ts("sent_at").notNull(),
});

export const dispatcherMeta = pgTable("dispatcher_meta", {
  key: id191("key").primaryKey(),
  value: text("value").notNull(),
  updated_at: ts("updated_at").notNull(),
});
