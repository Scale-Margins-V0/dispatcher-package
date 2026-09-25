import { existsSync } from "node:fs";
import { getBuildInfo, type BuildInfo } from "./build-info.js";
import { loadEventsConfig, type EventsConfig } from "../events/config.js";
import { getTelemetryStatus } from "../telemetry/posthog.js";
import { getDispatchConfig, getIdType, configPathFromEnv } from "../user-lookup/config.js";
import { lookupUsers } from "../user-lookup/index.js";
import { envYamlPath, loadEnvYaml } from "../env-yaml.js";
import { primarySender, registry } from "../providers/senders.js";
import { senderCredentials, type SenderCredentialReport } from "../providers/sender-credentials.js";
import type { SenderConfig } from "../providers/types.js";
import { lookupMode } from "../variables/guard.js";

type StatusValue = "ok" | "degraded" | "error";

interface CheckResult {
  ok: boolean;
  message?: string;
}

export interface RuntimeStatus {
  status: StatusValue;
  version: string;
  checks: {
    required_env: CheckResult;
    dispatch_config: CheckResult;
    event_config: CheckResult;
    telemetry: CheckResult;
  };
}

export interface DiagnosticsRequest {
  checks?: string[];
  sample_user_ids?: string[];
}

export interface UserLookupDiagnostic {
  pii_conversion_ok: boolean;
  requested_count: number;
  found_count: number;
  missing_user_ids: string[];
  email_available_count: number;
  resolved_field_names: string[];
  error?: string;
}

export type ProviderState = "active" | "ready" | "incomplete" | "not_configured";

export interface ProviderDiagnostic {
  channel: "email" | "whatsapp";
  provider: string;
  state: ProviderState;
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
  /** Per sender, what is missing — names the sender and the field to set. */
  problems?: string[];
}

const REQUIRED_ENV = [
  "SCALEMARGIN_DISPATCH_SECRET",
  "SCALEMARGIN_ANALYTICS_SECRET",
] as const;

function envPresence(names: readonly string[]): Record<string, boolean> {
  return Object.fromEntries(
    names.map((name) => [name, Boolean(process.env[name])])
  );
}

/** name → present, for one report: `SENDGRID_API_KEY` if the sender names that variable, else `sendgrid.api_key`. */
function checksOf(report: SenderCredentialReport): Record<string, boolean> {
  return Object.fromEntries(report.sets.flatMap((set) => set.checks).map((c) => [c.source, c.present]));
}

/** Webhook verification configured on any sender of the provider, or the events-level variable. */
function webhookVerified(reports: SenderCredentialReport[], eventsEnvName: string | undefined): boolean {
  return (
    reports.some((r) => r.webhook?.present) ||
    Boolean(eventsEnvName && process.env[eventsEnvName]?.trim())
  );
}

/**
 * One row per provider, built from the enabled `senders:` using it — never
 * from provider-wide environment variables, which a sender does not read.
 * `credential_sets` has one entry per sender and way to authenticate; its
 * `variables` name what the operator configured (the variable an `_env` field
 * points at, else the sender field) — never a value.
 */
function summarizeProviders(eventsConfig: EventsConfig): ProviderDiagnostic[] {
  let senders: SenderConfig[] = [];
  try {
    senders = loadEnvYaml().senders.filter((x) => x.enabled !== false) as SenderConfig[];
  } catch {
    senders = [];
  }
  const rows: Array<{
    channel: "email" | "whatsapp";
    provider: string;
    webhookEnabled: boolean;
    eventsEnv: string | undefined;
  }> = [
    {
      channel: "email",
      provider: "sendgrid",
      webhookEnabled: eventsConfig.providers.sendgrid.enabled,
      eventsEnv: eventsConfig.providers.sendgrid.signing_key_env ?? "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY",
    },
    {
      channel: "email",
      provider: "ses",
      webhookEnabled: eventsConfig.providers.ses.enabled,
      eventsEnv: "SES_EVENT_CONFIG_SET",
    },
    {
      channel: "whatsapp",
      provider: "gupshup",
      webhookEnabled: eventsConfig.providers.gupshup.enabled,
      eventsEnv: eventsConfig.providers.gupshup.secret_env ?? "GUPSHUP_WEBHOOK_SECRET",
    },
    {
      channel: "whatsapp",
      provider: "freshchat",
      webhookEnabled: Boolean(eventsConfig.providers.freshchat?.enabled),
      eventsEnv: eventsConfig.providers.freshchat?.secret_env ?? "FRESHCHAT_WEBHOOK_SECRET",
    },
  ];

  return rows.map(({ channel, provider, webhookEnabled, eventsEnv }) => {
    const reports = senders.filter((x) => x.provider === provider).map(senderCredentials);
    const active = reports.length > 0;
    const state: ProviderState = !active
      ? "not_configured"
      : reports.every((r) => r.satisfied)
        ? "active"
        : "incomplete";
    return {
      channel,
      provider,
      active,
      state,
      credential_sets: reports.flatMap((r) =>
        r.sets.map((set) => ({
          label: `${r.sender_id} · ${set.label}`,
          variables: Object.fromEntries(set.checks.map((c) => [c.source, c.present])),
          satisfied: set.satisfied,
        }))
      ),
      problems: reports.map((r) => r.problem).filter((p): p is string => Boolean(p)),
      webhook: { enabled: webhookEnabled, verification_configured: webhookVerified(reports, eventsEnv) },
    };
  });
}

export interface SenderDiagnostic {
  id: string;
  channel: "email" | "whatsapp";
  provider: string;
  from?: string;
  weight: number;
  enabled: boolean;
  organizations?: string[];
  breaker_state: "closed" | "open" | "half-open";
  credentials_satisfied: boolean;
  /** Configured name → resolved, e.g. { "sendgrid.api_key": true }. Never a value. */
  credentials: Record<string, boolean>;
  credential_problem?: string;
  credential_notes?: string[];
  webhook_verification: boolean;
}

function summarizeSenders(): SenderDiagnostic[] {
  try {
    const yaml = loadEnvYaml();
    return yaml.senders.map((s) => {
      const creds = senderCredentials(s as SenderConfig);
      return {
        id: s.id,
        channel: s.channel,
        provider: s.provider,
        from: s.from,
        weight: s.weight ?? 1,
        enabled: s.enabled !== false,
        organizations: s.organizations,
        breaker_state: registry.getBreakerState(s.id)?.state ?? "closed",
        credentials_satisfied: creds.satisfied,
        credentials: checksOf(creds),
        ...(creds.problem ? { credential_problem: creds.problem } : {}),
        ...(creds.notes.length ? { credential_notes: creds.notes } : {}),
        webhook_verification: creds.webhook?.present ?? false,
      };
    });
  } catch {
    return [];
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredEnvCheck(): CheckResult {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  return missing.length === 0
    ? { ok: true }
    : { ok: false, message: `Missing required env vars: ${missing.join(", ")}` };
}

function loadDispatchConfigCheck(): CheckResult {
  try {
    getDispatchConfig();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: safeError(error) };
  }
}

function loadEventsConfigCheck(): CheckResult {
  try {
    loadEventsConfig();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: safeError(error) };
  }
}

export function getRuntimeStatus(): RuntimeStatus {
  const checks = {
    required_env: requiredEnvCheck(),
    dispatch_config: loadDispatchConfigCheck(),
    event_config: loadEventsConfigCheck(),
    telemetry: { ok: true },
  };

  const failed = Object.values(checks).filter((check) => !check.ok);
  const status: StatusValue =
    failed.length === 0
      ? "ok"
      : failed.length === Object.keys(checks).length
        ? "error"
        : "degraded";

  return {
    status,
    version: getBuildInfo().version,
    checks,
  };
}

function summarizeEventsConfig(cfg: EventsConfig): {
  forward_mode: EventsConfig["forward"]["mode"];
  delivery_mode: EventsConfig["delivery"]["mode"];
  buffer_kind: EventsConfig["delivery"]["buffer"]["kind"];
  enabled_providers: string[];
} {
  return {
    forward_mode: cfg.forward.mode,
    delivery_mode: cfg.delivery.mode,
    buffer_kind: cfg.delivery.buffer.kind,
    enabled_providers: Object.entries(cfg.providers)
      .filter(([, provider]) => provider.enabled)
      .map(([name]) => name),
  };
}

async function runUserLookupDiagnostic(
  userIds: string[] | undefined
): Promise<UserLookupDiagnostic | undefined> {
  const sampleUserIds = Array.isArray(userIds)
    ? userIds
        .filter((value): value is string => typeof value === "string")
        .slice(0, 25)
    : [];

  if (sampleUserIds.length === 0) {
    return undefined;
  }

  try {
    const users = await lookupUsers(sampleUserIds);
    const missing = sampleUserIds.filter((userId) => !users.has(userId));
    const fieldNames = new Set<string>();
    let emailAvailableCount = 0;

    for (const user of users.values()) {
      if (user.email) {
        emailAvailableCount += 1;
      }
      for (const fieldName of Object.keys(user.fields)) {
        fieldNames.add(fieldName);
      }
    }

    return {
      pii_conversion_ok:
        missing.length === 0 && emailAvailableCount === sampleUserIds.length,
      requested_count: sampleUserIds.length,
      found_count: users.size,
      missing_user_ids: missing,
      email_available_count: emailAvailableCount,
      resolved_field_names: [...fieldNames],
    };
  } catch (error) {
    return {
      pii_conversion_ok: false,
      requested_count: sampleUserIds.length,
      found_count: 0,
      missing_user_ids: sampleUserIds,
      email_available_count: 0,
      resolved_field_names: [],
      error: safeError(error),
    };
  }
}

export async function buildDiagnosticsReport(
  request: DiagnosticsRequest = {}
): Promise<{
  status: RuntimeStatus;
  build: BuildInfo;
  runtime: {
    node_version: string;
    uptime_seconds: number;
    environment: string;
  };
  config: {
    dispatch_config_path: string;
    dispatch_config_present: boolean;
    env_yaml_path: string | null;
    env_yaml_present: boolean;
    email_provider: string;
    image_storage_provider: string;
    user_lookup_backend?: string;
    user_lookup_mode?: string;
    user_lookup_source?: {
      kind?: string;
      name?: string;
      id_column?: string;
      id_type: string;
    };
    user_lookup_batch?: {
      max_ids_per_query?: number;
      dedupe?: boolean;
    };
    placeholder_names: string[];
    events?: ReturnType<typeof summarizeEventsConfig>;
    telemetry: ReturnType<typeof getTelemetryStatus>;
    providers: ProviderDiagnostic[];
    senders: SenderDiagnostic[];
  };
  env: {
    required: Record<string, boolean>;
    provider: Record<string, boolean>;
  };
  checks?: {
    user_lookup?: UserLookupDiagnostic;
  };
}> {
  const build = getBuildInfo();
  const dispatchConfigPath = configPathFromEnv();
  const dispatchConfig = getDispatchConfig();
  const eventsConfig = loadEventsConfig();
  const emailProvider = primarySender("email")?.config.provider ?? "none";
  const primaryEmail = primarySender("email");
  const shouldRunUserLookup =
    request.checks?.includes("user_lookup") ||
    Array.isArray(request.sample_user_ids);
  const userLookup = shouldRunUserLookup
    ? await runUserLookupDiagnostic(request.sample_user_ids)
    : undefined;

  return {
    status: getRuntimeStatus(),
    build,
    runtime: {
      node_version: build.node_version,
      uptime_seconds: build.uptime_seconds,
      environment: build.environment,
    },
    config: {
      dispatch_config_path: dispatchConfigPath,
      dispatch_config_present: existsSync(dispatchConfigPath),
      env_yaml_path: envYamlPath(),
      env_yaml_present: Boolean(envYamlPath()),
      email_provider: emailProvider,
      image_storage_provider: process.env.IMAGE_STORAGE_PROVIDER || "none",
      user_lookup_backend: dispatchConfig.user_lookup.backend,
      user_lookup_mode: lookupMode(),
      user_lookup_source: dispatchConfig.user_lookup.source
        ? {
            kind: dispatchConfig.user_lookup.source.kind,
            name: dispatchConfig.user_lookup.source.name,
            id_column: dispatchConfig.user_lookup.source.id_column,
            id_type: getIdType(dispatchConfig),
          }
        : undefined,
      user_lookup_batch: dispatchConfig.user_lookup.batch,
      placeholder_names: Object.keys(dispatchConfig.placeholders),
      events: summarizeEventsConfig(eventsConfig),
      telemetry: getTelemetryStatus(),
      providers: summarizeProviders(eventsConfig),
      senders: summarizeSenders(),
    },
    env: {
      required: envPresence(REQUIRED_ENV),
      // The primary email sender's credentials, by the names it is configured with.
      provider: primaryEmail ? checksOf(senderCredentials(primaryEmail.config)) : {},
    },
    ...(userLookup ? { checks: { user_lookup: userLookup } } : {}),
  };
}
