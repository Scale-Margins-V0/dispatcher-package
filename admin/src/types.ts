export type StatusValue = "ok" | "degraded" | "error";

export interface CheckResult {
  ok: boolean;
  message?: string;
}

export interface AdminOverview {
  generated_at: string;
  status: {
    status: StatusValue;
    version: string;
    checks: Record<string, CheckResult>;
  };
  build: {
    version: string;
    git_sha: string;
    build_time: string;
    image_tag: string;
  };
  runtime: {
    node_version: string;
    uptime_seconds: number;
    environment: string;
  };
  config: {
    email_provider: string;
    image_storage_provider: string;
    user_lookup_backend?: string;
    user_lookup_source?: {
      kind?: string;
      name?: string;
      id_type: string;
    };
    user_lookup_batch?: {
      max_ids_per_query?: number;
      dedupe?: boolean;
    };
    placeholder_names: string[];
    events?: {
      forward_mode: string;
      delivery_mode: string;
      buffer_kind: string;
      enabled_providers: string[];
    };
    telemetry: Record<string, unknown>;
    providers: Array<{
      channel: "email" | "whatsapp";
      provider: string;
      state: "active" | "ready" | "incomplete" | "not_configured";
      active: boolean;
      credential_sets: Array<{
        label: string;
        variables: Record<string, boolean>;
        satisfied: boolean;
      }>;
      webhook?: {
        enabled: boolean;
        verification_configured: boolean;
      };
    }>;
  };
  env: {
    required: Record<string, boolean>;
    provider: Record<string, boolean>;
  };
}

export interface DispatchActivity {
  id: string;
  campaign_id: string;
  organization_id?: string;
  channel: string;
  provider: string;
  status: "accepted" | "completed" | "failed";
  recipient_count: number;
  sent_count?: number;
  failed_count?: number;
  duration_ms?: number;
  occurred_at: string;
  error_category?: string;
  error_message?: string;
  error_stack?: string;
}

export interface WebhookActivity {
  id: string;
  provider: string;
  direction: "inbound" | "outbound";
  status: "delivered" | "failed" | "rejected";
  event_count: number;
  http_status?: number;
  duration_ms?: number;
  attempt?: number;
  occurred_at: string;
  destination?: string;
  error_category?: string;
  error_message?: string;
}

export interface AdminActivity {
  generated_at: string;
  scope: { retention: string; started_at: string };
  summary: {
    accepted_dispatches: number;
    completed_dispatches: number;
    sent: number;
    failed: number;
    webhook_success_rate: number | null;
  };
  dispatches: DispatchActivity[];
  failures: Array<DispatchActivity | WebhookActivity>;
  webhooks: WebhookActivity[];
}

export type VariableSource = "field" | "computed" | "constant" | "query" | "api";

export interface ApiVarConfig {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  json_path?: string;
  body?: string;
  timeout_ms?: number;
}

/** Raw HTTP exchange returned by /variables/test for source=api. */
export interface ApiTestResponse {
  ok: boolean;
  status: number;
  time_ms: number;
  size: number;
  body: string;
}

export interface VariableTestResult {
  ok: boolean;
  value?: string;
  error?: string;
  response?: ApiTestResponse;
}

export interface AdminVariable {
  name: string;
  source: VariableSource;
  field: string | null;
  expr: string | null;
  fallback: string | null;
  config: Record<string, unknown> | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  preview: string;
}

export interface VariablePayload {
  name: string;
  source: VariableSource;
  field?: string;
  expr?: string;
  value?: string;
  sql?: string;
  api?: ApiVarConfig;
  fallback?: string;
  enabled?: boolean;
}

export interface LogEntry {
  id: string;
  ts: string;
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  request_id: string | null;
  campaign_id: string | null;
  component: string | null;
  message: string;
  stack: string | null;
  context: Record<string, unknown> | null;
}

export interface LogPage {
  generated_at: string;
  logs: LogEntry[];
  next_cursor: string | null;
}

export interface RecipientFailure {
  id: string;
  dispatch_run_id: string;
  campaign_id: string;
  user_id: string;
  provider: string;
  error_category: string;
  error_message: string;
  error_stack: string | null;
  context?: Record<string, unknown> | null;
  occurred_at: string;
}

export interface DispatchDetail {
  dispatch: DispatchActivity;
  recipient_failures: RecipientFailure[];
}

// --- Campaign console ---

export type RecipientStatus =
  | "complained"
  | "bounced"
  | "failed"
  | "unsubscribed"
  | "clicked"
  | "opened"
  | "read"
  | "delivered"
  | "dispatched"
  | "pending";

/** "campaign" = one-shot blast; "drip" = a multi-step (often multi-channel) sequence. */
export type ProgramKind = "campaign" | "drip";

export interface CampaignFunnel {
  unique_recipients: number;
  dispatched: number;
  delivered: number;
  /** Email/push tracking-pixel opens. Never merged with `read`. */
  opened: number;
  /** WhatsApp read receipts — a different signal from an email open. */
  read: number;
  clicked: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  failed: number;
}

export interface CampaignSummary {
  /** Grouping key: drip_sequence_id for drips, campaign_id for blasts. */
  program_id: string;
  program_kind: ProgramKind;
  /** Distinct drip steps; 0 for one-shot campaigns. */
  steps: number;
  /** Distinct wire sends — a drip fans out roughly people x steps. */
  sends: number;
  organization_id: string | null;
  runs: number;
  accepted_runs: number;
  failed_runs: number;
  /**
   * Sum of run recipient counts. For a drip this counts SENDS, not people —
   * show `events.unique_recipients` to humans instead.
   */
  recipients: number;
  sent: number;
  failed: number;
  first_activity: string;
  last_activity: string;
  channels: string[];
  providers: string[];
  has_callback: boolean;
  events: CampaignFunnel | null;
}

export interface CampaignPage {
  generated_at: string;
  campaigns: CampaignSummary[];
  next_cursor: string | null;
}

export interface ProgramStep {
  step_id: string;
  channel: string;
  provider: string;
  sends: number;
  first_activity: string;
  last_activity: string;
}

export interface CampaignInfo {
  program_id: string;
  program_kind: ProgramKind;
  /** Ordered drip steps; empty for one-shot campaigns. */
  steps: ProgramStep[];
  sends: number;
  organization_id: string | null;
  /** A drip picks a channel per step, so a program can span channels. */
  channels: string[];
  providers: string[];
  runs: number;
  accepted_runs: number;
  failed_runs: number;
  recipients: number;
  sent: number;
  failed: number;
  first_activity: string | null;
  last_activity: string | null;
  active: boolean;
  callback: { registered: boolean; destination: string; last_used_at: string } | null;
  funnel: CampaignFunnel;
  outbox: Record<string, number>;
}

export interface RecipientRollup {
  user_id: string;
  status: RecipientStatus;
  stages: {
    dispatched: boolean;
    delivered: boolean;
    opened: boolean;
    read: boolean;
    clicked: boolean;
  };
  flags: { bounced: boolean; complained: boolean; unsubscribed: boolean; failed: boolean };
  event_count: number;
  /** Drip steps this person was touched by; 0 for one-shot campaigns. */
  steps: number;
  /** >1 means their journey crossed channels (e.g. email -> WhatsApp). */
  channel_count: number;
  first_event_at: string;
  last_event_at: string;
}

export interface RecipientPage {
  generated_at: string;
  status_counts: Record<RecipientStatus, number>;
  recipients: RecipientRollup[];
  next_cursor: string | null;
}

export interface CampaignEvent {
  id: string;
  /** The wire id — one send (for drips: one recipient x one step). */
  campaign_id: string;
  program_id: string;
  program_kind: ProgramKind;
  step_id: string | null;
  organization_id: string;
  user_id: string;
  channel: string;
  event: string;
  provider: string;
  provider_message_id: string | null;
  occurred_at: string;
  received_at: string;
  metadata: Record<string, unknown> | null;
  dedupe_key: string;
}

export interface CampaignEventPage {
  generated_at: string;
  events: CampaignEvent[];
  next_cursor: string | null;
}

export interface RecipientTimeline {
  program_id: string;
  user_id: string;
  status: RecipientStatus;
  events: CampaignEvent[];
  recipient_failures: RecipientFailure[];
}

export interface DispatchPage {
  generated_at: string;
  dispatches: DispatchActivity[];
  next_cursor: string | null;
}

export interface CampaignOutboxEntry {
  id: string;
  status: string;
  attempts: number;
  destination: string;
  last_error: string | null;
  created_at: string;
  next_attempt_at: string;
  delivered_at: string | null;
  event: Record<string, unknown>;
}

export interface CampaignOutboxPage {
  generated_at: string;
  status_counts: Record<string, number>;
  entries: CampaignOutboxEntry[];
  next_cursor: string | null;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string | null;
}

export interface SessionInfo {
  authenticated: boolean;
  user?: SessionUser;
}

export interface OrgMember {
  id: string;
  role: string;
  createdAt?: string;
  user: { id: string; name: string; email: string };
}

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  members?: OrgMember[];
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt?: string;
  accept_url: string;
}

export type LogLevelName = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface LogWebhookSettings {
  enabled: boolean;
  url: string;
  levels: LogLevelName[];
  has_secret: boolean;
  secret: string;
}

export interface LogWebhookInput {
  enabled: boolean;
  url: string;
  levels: LogLevelName[];
  secret?: string;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  key: string;
  prefix: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface ConnectionEndpoint {
  method: string;
  path: string;
  purpose: string;
}

/** What an operator copies into Atlas, plus the fixed endpoint contract. */
export interface ConnectionInfo {
  base_url: string;
  api_version: string;
  configured_public_url: boolean;
  /** Name of the env var holding the Atlas key — never the value. */
  atlas_key_env: string;
  atlas_key_configured: boolean;
  atlas_key_warning: string | null;
  /** Origins allowed to call the external API from a browser; empty = disabled. */
  cors_env: string;
  cors_origins: string[];
  cors_warning: string | null;
  endpoints: ConnectionEndpoint[];
  internal_endpoints: ConnectionEndpoint[];
}
