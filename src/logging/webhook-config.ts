/**
 * Log-webhook config, cached as a sync snapshot the (hot-path) sink reads
 * without awaiting. Stored as JSON in dispatcher_meta; refreshed at bootstrap
 * and after every admin write. Mirrors src/variables/service.ts.
 */

import { getMeta, setMeta } from "../db/repos/meta.js";
import type { LogLevel } from "../db/schema/shared.js";
import { isDbInitialized } from "../db/state.js";

export const LOG_WEBHOOK_KEY = "log_webhook";

export type LogWebhookConfig = {
  enabled: boolean;
  url: string;
  levels: LogLevel[];
  secret?: string;
};

const LEVEL_LIST: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];
const DEFAULT: LogWebhookConfig = { enabled: false, url: "", levels: ["warn", "error", "fatal"] };
const LEVELS = new Set<LogLevel>(LEVEL_LIST);

let snapshot: LogWebhookConfig = DEFAULT;

export function getLogWebhookConfig(): LogWebhookConfig {
  return snapshot;
}

export async function refreshLogWebhookConfig(): Promise<void> {
  if (!isDbInitialized()) return;
  const raw = await getMeta(LOG_WEBHOOK_KEY);
  if (!raw) {
    snapshot = DEFAULT;
    return;
  }
  try {
    const p = JSON.parse(raw) as Partial<LogWebhookConfig>;
    const legacyMin = LEVELS.has((p as { min_level?: LogLevel }).min_level as LogLevel)
      ? (p as { min_level: LogLevel }).min_level
      : "warn";
    const levels = Array.isArray(p.levels)
      ? p.levels.filter((level): level is LogLevel => LEVELS.has(level as LogLevel))
      : LEVEL_LIST.slice(LEVEL_LIST.indexOf(legacyMin));
    snapshot = {
      enabled: Boolean(p.enabled),
      url: typeof p.url === "string" ? p.url : "",
      levels: levels.length > 0 ? levels : DEFAULT.levels,
      ...(p.secret ? { secret: String(p.secret) } : {}),
    };
  } catch {
    snapshot = DEFAULT;
  }
}

export async function saveLogWebhookConfig(cfg: LogWebhookConfig): Promise<void> {
  await setMeta(LOG_WEBHOOK_KEY, JSON.stringify(cfg));
  await refreshLogWebhookConfig();
}

export function setLogWebhookConfigForTests(cfg: LogWebhookConfig): void {
  snapshot = cfg;
}

export function resetLogWebhookConfigForTests(): void {
  snapshot = DEFAULT;
}
