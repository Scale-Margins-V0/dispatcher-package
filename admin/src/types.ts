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
  };
  env: {
    required: Record<string, boolean>;
    provider: Record<string, boolean>;
  };
}

export interface DispatchActivity {
  id: string;
  campaign_id: string;
  channel: string;
  provider: string;
  status: "accepted" | "completed" | "failed";
  recipient_count: number;
  sent_count?: number;
  failed_count?: number;
  duration_ms?: number;
  occurred_at: string;
  error_category?: string;
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
}

export interface AdminActivity {
  generated_at: string;
  scope: { retention: string; max_items: number; started_at: string };
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
