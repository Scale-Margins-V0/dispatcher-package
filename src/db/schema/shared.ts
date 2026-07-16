/**
 * Dialect-neutral row types for the dispatcher state DB.
 * Repos accept/return these; the per-dialect table defs in sqlite.ts/mysql.ts/pg.ts
 * must stay column-compatible with them (same names, same JS-side types).
 */

export type VariableSource = "field" | "computed" | "constant" | "query" | "api";

/** source=constant */
export type ConstantConfig = { value: string };
/** source=query — SELECT with {{user_id}} etc. tokens (bound, not interpolated). */
export type QueryConfig = { sql: string };
/** source=api — HTTP fetch with token interpolation + JSON-path extraction. */
export type ApiConfig = {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  json_path: string;
  body?: string;
  timeout_ms?: number;
};
export type VariableConfig = ConstantConfig | QueryConfig | ApiConfig;

export type VariableRow = {
  id: string;
  name: string;
  source: VariableSource;
  field: string | null;
  expr: string | null;
  fallback: string | null;
  /** Type-specific config for constant/query/api (null for field/computed). */
  config: Record<string, unknown> | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
  updated_by: string | null;
};

export type DispatchRunStatus = "accepted" | "completed" | "failed";

export type DispatchRunRow = {
  id: string;
  campaign_id: string;
  organization_id: string | null;
  channel: string;
  provider: string;
  status: DispatchRunStatus;
  recipient_count: number;
  sent_count: number | null;
  failed_count: number | null;
  duration_ms: number | null;
  error_category: string | null;
  error_message: string | null;
  error_stack: string | null;
  occurred_at: Date;
  updated_at: Date;
};

export type RecipientFailureRow = {
  id: string;
  dispatch_run_id: string;
  campaign_id: string;
  /** Opaque client user id — never PII (no email/phone/name). */
  user_id: string;
  provider: string;
  error_category: string;
  error_message: string;
  error_stack: string | null;
  context: Record<string, unknown> | null;
  occurred_at: Date;
};

export type WebhookDirection = "inbound" | "outbound";
export type WebhookStatus = "delivered" | "failed" | "rejected";

export type WebhookActivityRow = {
  id: string;
  provider: string;
  direction: WebhookDirection;
  status: WebhookStatus;
  event_count: number;
  http_status: number | null;
  duration_ms: number | null;
  attempt: number | null;
  destination: string | null;
  error_category: string | null;
  error_message: string | null;
  occurred_at: Date;
};

export type CampaignCallbackRow = {
  campaign_id: string;
  organization_id: string;
  analytics_callback_url: string;
  created_at: Date;
  last_used_at: Date;
};

export type OutboxStatus = "pending" | "delivering" | "delivered" | "failed";

export type OutboxRow = {
  id: string;
  callback_url: string;
  campaign_id: string;
  organization_id: string;
  /** Full StandardizedEvent envelope, stored verbatim. */
  event: Record<string, unknown>;
  idempotency_key: string;
  status: OutboxStatus;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  created_at: Date;
  delivered_at: Date | null;
};

/**
 * One PII-stripped per-recipient lifecycle event (dispatched/delivered/opened/…),
 * persisted for the admin campaign console. Mirrors StandardizedEvent minus the
 * callback URL; user_id is the client's opaque id, never an address.
 */
export type CampaignEventRow = {
  id: string;
  campaign_id: string;
  organization_id: string;
  user_id: string;
  channel: string;
  event: string;
  provider: string;
  provider_message_id: string | null;
  /** Provider clock. */
  occurred_at: Date;
  /** Server clock at persist time. */
  received_at: Date;
  metadata: Record<string, unknown> | null;
  /** envelope idempotency_key when present, else a deterministic hash — unique. */
  dedupe_key: string;
};

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type AppLogRow = {
  id: string;
  ts: Date;
  level: LogLevel;
  request_id: string | null;
  campaign_id: string | null;
  component: string | null;
  message: string;
  stack: string | null;
  context: Record<string, unknown> | null;
};

export type DevSentCampaignRow = {
  campaign_id: string;
  sent_at: Date;
};

export type MetaRow = {
  key: string;
  value: string;
  updated_at: Date;
};

/** dispatcher_meta keys used by the app. */
export const META_KEYS = {
  yamlImportDoneAt: "yaml_import_done_at",
  campaignEventsBackfillDoneAt: "campaign_events_backfill_done_at",
} as const;
