import { existsSync } from "node:fs";
import { getBuildInfo, type BuildInfo } from "./build-info.js";
import { loadEventsConfig, type EventsConfig } from "../events/config.js";
import { getTelemetryStatus } from "../telemetry/posthog.js";
import { getDispatchConfig, getIdType, configPathFromEnv } from "../user-lookup/config.js";
import { lookupUsers } from "../user-lookup/index.js";

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

const REQUIRED_ENV = [
  "SCALEMARGIN_DISPATCH_SECRET",
  "SCALEMARGIN_ANALYTICS_SECRET",
] as const;

const PROVIDER_ENV: Record<string, readonly string[]> = {
  ses: ["AWS_REGION"],
  sendgrid: ["SENDGRID_API_KEY"],
};

function envPresence(names: readonly string[]): Record<string, boolean> {
  return Object.fromEntries(
    names.map((name) => [name, Boolean(process.env[name])])
  );
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
    email_provider: string;
    image_storage_provider: string;
    user_lookup_backend?: string;
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
  const emailProvider = process.env.EMAIL_PROVIDER || "ses";
  const providerEnv = PROVIDER_ENV[emailProvider] ?? [];
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
      email_provider: emailProvider,
      image_storage_provider: process.env.IMAGE_STORAGE_PROVIDER || "none",
      user_lookup_backend: dispatchConfig.user_lookup.backend,
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
    },
    env: {
      required: envPresence(REQUIRED_ENV),
      provider: envPresence(providerEnv),
    },
    ...(userLookup ? { checks: { user_lookup: userLookup } } : {}),
  };
}
