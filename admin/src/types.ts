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

export interface AdminVariable {
  name: string;
  source: "field" | "computed";
  field: string | null;
  expr: string | null;
  fallback: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  preview: string;
}

export interface VariablePayload {
  name: string;
  source: "field" | "computed";
  field?: string;
  expr?: string;
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
  occurred_at: string;
}

export interface DispatchDetail {
  dispatch: DispatchActivity;
  recipient_failures: RecipientFailure[];
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
