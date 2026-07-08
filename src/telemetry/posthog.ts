import { createHash } from "node:crypto";
import { PostHog } from "posthog-node";
import { getBuildInfo } from "../ops/build-info.js";

type TelemetryValue = string | number | boolean | null | undefined;
type TelemetryProperties = Record<string, TelemetryValue>;

const APP_NAME = "dispatcher";
const DEFAULT_POSTHOG_API_KEY =
  "phc_wLF9hjncErm9EpnGSXJQKn8ocMnh69jU6F9H9cNaLU6U";
const DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com";
const DEFAULT_DISTINCT_ID = "scalemargin-dispatcher-anonymous";

function isDisabled(): boolean {
  const value = process.env.DISPATCHER_TELEMETRY_DISABLED?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function getDistinctId(): string {
  const configured = process.env.DISPATCHER_TELEMETRY_DISTINCT_ID?.trim();
  if (configured) {
    return `dispatcher-${hashValue(configured)}`;
  }
  return DEFAULT_DISTINCT_ID;
}

function safeErrorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "Error";
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "unknown_error";
  }
  if (/timeout|timed out/i.test(error.message)) {
    return "timeout";
  }
  if (/signature/i.test(error.message)) {
    return "signature_error";
  }
  if (/config|environment|env/i.test(error.message)) {
    return "configuration_error";
  }
  return "error";
}

function stackHash(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.stack) {
    return undefined;
  }
  return hashValue(error.stack);
}

function commonProperties(
  properties?: TelemetryProperties
): Record<string, TelemetryValue> {
  const build = getBuildInfo();
  return {
    app: APP_NAME,
    environment: build.environment,
    dispatcher_version: build.version,
    git_sha: build.git_sha,
    image_tag: build.image_tag,
    node_version: build.node_version,
    telemetry_anonymous: true,
    $geoip_disable: true,
    ...properties,
  };
}

const apiKey = process.env.POSTHOG_API_KEY?.trim() || DEFAULT_POSTHOG_API_KEY;
const client =
  !isDisabled() && apiKey
    ? new PostHog(apiKey, {
        host: process.env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST,
        enableExceptionAutocapture: false,
      })
    : null;

export const telemetry = {
  isEnabled: (): boolean => client !== null,

  capture: (event: string, properties?: TelemetryProperties): void => {
    if (process.env.VITEST === "true") {
      return;
    }
    client?.capture({
      distinctId: getDistinctId(),
      event,
      properties: commonProperties(properties),
    });
  },

  captureException: (
    error: unknown,
    properties?: TelemetryProperties
  ): void => {
    if (process.env.VITEST === "true") {
      return;
    }
    client?.capture({
      distinctId: getDistinctId(),
      event: "dispatcher_error",
      properties: commonProperties({
        ...properties,
        error_name: safeErrorName(error),
        error_category: safeErrorMessage(error),
        stack_hash: stackHash(error),
      }),
    });
  },

  shutdown: async (): Promise<void> => {
    await client?.shutdown();
  },
};

export function getTelemetryStatus(): {
  enabled: boolean;
  disabled_by_env: boolean;
  posthog_configured: boolean;
  posthog_host: string;
} {
  return {
    enabled: telemetry.isEnabled(),
    disabled_by_env: isDisabled(),
    posthog_configured: Boolean(apiKey),
    posthog_host: process.env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST,
  };
}
