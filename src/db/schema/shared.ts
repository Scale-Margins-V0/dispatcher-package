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
  /** Appended to the URL; values take {{tokens}} and are URL-encoded. */
  query?: Array<{ key: string; value: string }>;
  headers?: Record<string, string>;
  json_path: string;
  body?: string;
  timeout_ms?: number;
  /** Attached call metadata schema, by id — see src/variables/call-metadata.ts. */
  metadata?: { id: string; required: boolean } | null;
  /** Addressable response paths — see src/variables/api-response.ts. */
  response_schema?: Array<{
    path: string;
    type: "string" | "number" | "boolean" | "object" | "array" | "null";
    example?: string;
  }>;
};
export type VariableConfig = ConstantConfig | QueryConfig | ApiConfig;

export type VariableRow = {
  id: string;
  name: string;
  source: VariableSource;
  field: string | null;
  expr: string | null;
  fallback: string | null;
  /**
   * Last known preview for the fictional sample record. Rendered on write for
   * field/computed/constant; for query/api it is whatever the caller's live
   * test returned, because re-running a SELECT or an HTTP call on every list
   * would make reading the catalog a side-effecting operation.
   */
  sample: string | null;
  /** Type-specific config for constant/query/api (null for field/computed). */
  config: Record<string, unknown> | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
  updated_by: string | null;
};

/** "campaign" = one-shot blast; "drip" = one step of a multi-step sequence. */
export type ProgramKind = "campaign" | "drip";

export type DispatchRunStatus = "accepted" | "completed" | "failed";

export type DispatchRunRow = {
  id: string;
  /** The wire id — one SEND (for drips: one recipient × one step). */
  campaign_id: string;
  /** Grouping key: drip_sequence_id for drip steps, else campaign_id. */
  program_id: string;
  program_kind: ProgramKind;
  step_id: string | null;
  organization_id: string | null;
  channel: string;
  provider: string;
  status: DispatchRunStatus;
  recipient_count: number;
  sent_count: number | null;
  failed_count: number | null;
  duration_ms: number | null;
  /** Variable resolutions attempted across the run: recipients × tokens used. */
  resolution_total: number | null;
  /** How many of those fell back. `fallback_rate` = fallbacks / total. */
  resolution_fallbacks: number | null;
  error_category: string | null;
  error_message: string | null;
  error_stack: string | null;
  occurred_at: Date;
  updated_at: Date;
};

/** One key of a call metadata schema. */
export type CallMetadataKey = {
  /** Identifier; used in an api variable's request as `{{key.k}}` / `{{key.v}}`. */
  key: string;
  /** A sample value — shown in the UI, never sent. */
  placeholder?: string;
  /** Optional validation for the value, once values are wired. */
  regex?: string;
};

export type CallMetadataRow = {
  id: string;
  name: string;
  keys: CallMetadataKey[];
  created_at: Date;
  updated_at: Date;
  updated_by: string | null;
};

export type SendLogStatus = "sent" | "failed";

/**
 * One recipient × one send, success or failure.
 *
 * Supersedes RecipientFailureRow, which only ever recorded the failures — a
 * successful send left no per-recipient trace outside the event stream. This is
 * the highest-volume table in the state DB (one row per recipient per send), so
 * it carries its own retention window and row cap.
 *
 * `user_id` is the client's opaque id, never an address.
 */
/**
 * A provider message id, saved so the company running the dispatcher can look
 * it up in their own database and poll the provider for status themselves.
 *
 * Deliberately NOT a status projection: the dispatcher records that it sent a
 * message and what the provider called it. Whether that message was later
 * delivered or read is the provider's answer to give, not ours to cache.
 *
 * Pruned on `DISPATCHER_MESSAGE_ID_TTL`, which is mandatory — see
 * src/config/duration.ts.
 */
export type ProviderMessageIdRow = {
  id: string;
  /** `freshchat` | `gupshup` — only WhatsApp sends are recorded. */
  provider: string;
  /** What the provider called the message. Freshchat returns `request_id`. */
  provider_message_id: string;
  /** The recipient — the same user id ScaleMargin sent in the dispatch. */
  user_id: string;
  sent_at: Date;
};

export type SendLogRow = {
  id: string;
  /** The dispatch_runs row this send belonged to. */
  dispatch_run_id: string;
  /** The wire id — one SEND (for drips: one recipient × one step). */
  campaign_id: string;
  /** Grouping key: drip_sequence_id for drip steps, else campaign_id. */
  program_id: string;
  step_id: string | null;
  organization_id: string | null;
  user_id: string;
  channel: string;
  provider: string;
  /** Best available template identity — see deriveTemplateRef(). */
  template_ref: string | null;
  status: SendLogStatus;
  provider_message_id: string | null;
  /** Time spent inside provider.send() alone, not the whole run. */
  latency_ms: number | null;
  error_category: string | null;
  error_message: string | null;
  /** Variables referenced by this message that resolved to their fallback. */
  fallbacks_used: number | null;
  occurred_at: Date;
};

/**
 * One row per program — the durable rollup a human calls "the campaign".
 *
 * Exists because campaign_events is pruned (90 days / 500k rows by default), so
 * anything computed live from it disappears. This table is never pruned.
 *
 * Recomputed wholesale by refreshCampaignSummary(), never incremented: webhook
 * retries are absorbed by insert-ignore on dedupe_key, which cannot report how
 * many rows it actually inserted, so a delta counter would drift upward forever.
 */
export type CampaignSummaryRollupRow = {
  program_id: string;
  program_kind: ProgramKind;
  organization_id: string | null;
  /** Last seen. A drip may span channels; listCampaignChannels has the full set. */
  channel: string | null;
  provider: string | null;
  template_ref: string | null;
  /** sum(dispatch_runs.recipient_count) — counts SENDS, not people. */
  total_recipients: number;
  sent: number;
  failed: number;
  fallbacks_used: number | null;
  /** Distinct people, from the event funnel — the headcount total_recipients is not. */
  unique_recipients: number;
  dispatched: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  first_send_at: Date | null;
  last_event_at: Date | null;
  /** When the rollup was last recomputed, not when the campaign last ran. */
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
 * Wire campaign_id → program mapping row.
 *
 * For drips the wire id is `drip_{enrollmentId}_{stepId}` — unique per
 * (sequence × lead × step) — so it names a SEND, not a campaign. Written at
 * dispatch time (where drip_sequence_id is available) so inbound provider
 * webhooks, which only carry the wire id, can still resolve their program.
 */
export type DispatchProgramRow = {
  campaign_id: string;
  program_id: string;
  program_kind: ProgramKind;
  step_id: string | null;
  organization_id: string;
  created_at: Date;
  last_seen_at: Date;
};

/**
 * One PII-stripped per-recipient lifecycle event (dispatched/delivered/opened/…),
 * persisted for the admin campaign console. Mirrors StandardizedEvent minus the
 * callback URL; user_id is the client's opaque id, never an address.
 */
export type CampaignEventRow = {
  id: string;
  /** The wire id — one SEND (for drips: one recipient × one step). */
  campaign_id: string;
  /** Grouping key a human calls "the campaign": drip_sequence_id, else campaign_id. */
  program_id: string;
  program_kind: ProgramKind;
  /** Drip step this send belongs to; null for one-shot campaigns. */
  step_id: string | null;
  organization_id: string;
  user_id: string;
  channel: string;
  event: string;
  provider: string;
  provider_message_id: string | null;
  sender_id?: string | null;
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

export type ApiKeyRow = {
  id: string;
  name: string;
  key_hash: string;
  key_ciphertext: string;
  key_prefix: string;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};

/** dispatcher_meta keys used by the app. */
export const META_KEYS = {
  yamlImportDoneAt: "yaml_import_done_at",
  campaignEventsBackfillDoneAt: "campaign_events_backfill_done_at",
  campaignSummaryBackfillDoneAt: "campaign_summary_backfill_done_at",
} as const;

/** What a dispatch_metrics row measures — see src/metrics/collector.ts. */
export type MetricKind =
  | "dispatch"
  | "lookup"
  | "api_call"
  | "query_var"
  | "message_resolve"
  | "provider_send"
  | "message_e2e";

export type MetricCounters = {
  count: number;
  ok: number;
  failed: number;
  timeout: number;
  skipped: number;
  fallback: number;
  items: number;
  sum_ms: number;
  min_ms: number | null;
  max_ms: number | null;
  peak_per_sec: number;
  /** Histogram b0..b10, bounds in src/metrics/histogram.ts. */
  buckets: number[];
};

export type DispatchMetricRow = MetricCounters & {
  id: string;
  minute: number;
  program_id: string;
  step_id: string;
  kind: MetricKind;
  subject: string;
};
