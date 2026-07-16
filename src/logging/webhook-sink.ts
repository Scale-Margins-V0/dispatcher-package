/**
 * Per-log webhook forwarder — a pino multistream sink that POSTs each log line
 * (at or above the configured min level) to an admin-set URL. Same discipline
 * as DbLogSink: fire-and-forget, never blocks, never logs through the logger
 * (that would recurse), swallows errors to rate-limited stderr. Concurrency is
 * capped and excess is dropped so a slow/dead endpoint can't pile up.
 */

import { createHmac } from "node:crypto";
import type { LogLevel } from "../db/schema/shared.js";
import { getLogWebhookConfig, type LogWebhookConfig } from "./webhook-config.js";

const LABEL_BY_NUM: Record<number, LogLevel> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};
const KNOWN_KEYS = new Set([
  "level",
  "time",
  "pid",
  "hostname",
  "msg",
  "request_id",
  "campaign_id",
  "component",
  "err",
  "stack",
]);

const TIMEOUT_MS = 4_000;
const MAX_INFLIGHT = 5;

export type LogWebhookPayload = {
  id: string;
  ts: string;
  level: LogLevel;
  component: string | null;
  request_id: string | null;
  campaign_id: string | null;
  message: string;
  stack: string | null;
  context: Record<string, unknown> | null;
};

export function payloadFromLine(parsed: Record<string, unknown>): LogWebhookPayload {
  const err = parsed.err as { message?: string; stack?: string } | undefined;
  const context: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) if (!KNOWN_KEYS.has(k)) context[k] = v;
  const levelNum = typeof parsed.level === "number" ? parsed.level : 30;
  return {
    id: crypto.randomUUID(),
    ts: new Date(typeof parsed.time === "number" ? parsed.time : Date.now()).toISOString(),
    level: LABEL_BY_NUM[levelNum] ?? "info",
    component: (parsed.component as string | undefined) ?? null,
    request_id: (parsed.request_id as string | undefined) ?? null,
    campaign_id: (parsed.campaign_id as string | undefined) ?? null,
    message: String(parsed.msg ?? err?.message ?? ""),
    stack: err?.stack ?? (parsed.stack as string | undefined) ?? null,
    context: Object.keys(context).length > 0 ? context : null,
  };
}

/** Deliver one payload. Awaitable — used by the sink and by the settings "test". */
export async function deliverLogWebhook(
  cfg: LogWebhookConfig,
  payload: LogWebhookPayload
): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!/^https?:\/\//i.test(cfg.url)) return { ok: false, error: "url must be http(s)" };
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.secret) {
    headers["x-dispatcher-log-signature"] =
      "sha256=" + createHmac("sha256", cfg.secret).update(body).digest("hex");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(cfg.url, { method: "POST", headers, body, signal: controller.signal });
    return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "request failed" };
  } finally {
    clearTimeout(timer);
  }
}

class LogWebhookSink {
  private inflight = 0;
  private lastFailureNoteAt = 0;

  write(line: string): void {
    if (process.env.VITEST === "true") return;
    const cfg = getLogWebhookConfig();
    if (!cfg.enabled || !cfg.url) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const levelNum = typeof parsed.level === "number" ? parsed.level : 30;
    const level = LABEL_BY_NUM[levelNum] ?? "info";
    if (!cfg.levels.includes(level)) return;
    if (this.inflight >= MAX_INFLIGHT) return; // drop-on-overflow — never block/grow
    this.inflight++;
    void deliverLogWebhook(cfg, payloadFromLine(parsed))
      .then((r) => {
        if (!r.ok) this.noteFailure(r.error ?? "unknown");
      })
      .catch((e) => this.noteFailure(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        this.inflight--;
      });
  }

  /** Never recurse into the logger; rate-limited stderr only. */
  private noteFailure(msg: string): void {
    const now = Date.now();
    if (now - this.lastFailureNoteAt > 60_000) {
      this.lastFailureNoteAt = now;
      console.error("[LogWebhook] delivery failed:", msg);
    }
  }
}

export const logWebhookSink = new LogWebhookSink();
