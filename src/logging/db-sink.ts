/**
 * Batched app_logs sink for pino.multistream. Non-blocking and failure-proof:
 * it lazily no-ops until the state DB is up, swallows every write error, and
 * must never log through the logger it feeds (that would recurse).
 */

import { isDbInitialized } from "../db/state.js";
import type { AppLogRow, LogLevel } from "../db/schema/shared.js";

const LEVEL_LABELS: Record<number, LogLevel> = {
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

const FLUSH_ROWS = 50;
const FLUSH_MS = 2_000;
/** If the DB never comes up, don't grow the buffer forever. */
const MAX_PENDING = 5_000;

function rowFromLine(parsed: Record<string, unknown>): AppLogRow {
  const err = parsed.err as { message?: string; stack?: string; type?: string } | undefined;
  const context: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!KNOWN_KEYS.has(key)) context[key] = value;
  }
  if (err?.message) context.error_message = err.message;
  if (err?.type) context.error_type = err.type;
  return {
    id: crypto.randomUUID(),
    ts: new Date(typeof parsed.time === "number" ? parsed.time : Date.now()),
    level: LEVEL_LABELS[parsed.level as number] ?? "info",
    request_id: (parsed.request_id as string | undefined) ?? null,
    campaign_id: (parsed.campaign_id as string | undefined) ?? null,
    component: (parsed.component as string | undefined) ?? null,
    message: String(parsed.msg ?? err?.message ?? ""),
    stack: err?.stack ?? (parsed.stack as string | undefined) ?? null,
    context: Object.keys(context).length > 0 ? context : null,
  };
}

export class DbLogSink {
  private buffer: AppLogRow[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private lastFailureNoteAt = 0;

  /** pino stream contract. */
  write(line: string): void {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      this.buffer.push(rowFromLine(parsed));
      if (this.buffer.length > MAX_PENDING) {
        this.buffer.splice(0, this.buffer.length - MAX_PENDING);
      }
      if (this.buffer.length >= FLUSH_ROWS) {
        void this.flush();
      } else {
        this.ensureTimer();
      }
    } catch {
      // Malformed line — drop it; the sink must never throw into pino.
    }
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_MS);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!isDbInitialized() || this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    // Lazy import keeps the drizzle/native-driver chain out of the logger's
    // import graph — the logger is imported by nearly every module.
    this.flushing = import("../db/repos/logs.js")
      .then(({ insertLogs }) => insertLogs(batch))
      .catch((error) => {
        // Rate-limited stderr note; never recurse into the logger.
        const now = Date.now();
        if (now - this.lastFailureNoteAt > 60_000) {
          this.lastFailureNoteAt = now;
          console.error(
            `[LogSink] Failed to persist ${batch.length} log rows:`,
            error instanceof Error ? error.message : error
          );
        }
      })
      .finally(() => {
        this.flushing = null;
      });
    return this.flushing;
  }

  pendingCount(): number {
    return this.buffer.length;
  }
}

export const dbLogSink = new DbLogSink();

/** Await outstanding rows — called from graceful shutdown. */
export async function flushLogSink(): Promise<void> {
  await dbLogSink.flush();
}
