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
