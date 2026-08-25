/**
 * Collects per-recipient send rows during a dispatch and writes them once, at
 * the end, in chunks.
 *
 * Two rules, both learned from the rest of the dispatch path:
 *
 *   1. **Never write inside the send loop.** One insert per recipient would add
 *      a database round trip to every message. Rows accumulate in memory and
 *      flush once — a 50,000-recipient campaign becomes 250 statements, not
 *      50,000.
 *   2. **Never fail a send for bookkeeping.** flush() swallows and logs, exactly
 *      like the record* helpers in src/admin/activity.ts. A dispatch that
 *      delivered successfully must not be reported as failed because a log
 *      insert did not land.
 *
 * A run with no `dispatch_run_id` (nothing to attach rows to) collects nothing,
 * so the caller does not have to branch.
 */

import { insertSendLogs } from "../db/repos/send-logs.js";
import { isDbInitialized } from "../db/state.js";
import { componentLogger } from "../logging/logger.js";
import type { SendLogRow, SendLogStatus } from "../db/schema/index.js";

const log = componentLogger("dispatch.send-logs");

/** Column width is varchar(191) for ids, text for the message. */
const ID_MAX = 191;
const ERROR_MAX = 2000;

const clamp = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 3)}...`;

export type SendLogEntry = {
  user_id: string;
  status: SendLogStatus;
  provider_message_id?: string | null;
  latency_ms?: number | null;
  error_category?: string | null;
  error_message?: string | null;
  fallbacks_used?: number | null;
};

export type SendLogContext = {
  dispatch_run_id: string | undefined;
  campaign_id: string;
  program_id: string;
  step_id: string | null;
  organization_id: string | null;
  channel: string;
  provider: string;
  template_ref: string | null;
};

export class SendLogRecorder {
  private readonly rows: SendLogRow[] = [];

  constructor(private readonly ctx: SendLogContext) {}

  /** True when rows will actually be persisted — lets callers skip the work entirely. */
  get enabled(): boolean {
    return Boolean(this.ctx.dispatch_run_id) && isDbInitialized();
  }

  add(entry: SendLogEntry): void {
    if (!this.enabled) return;
    this.rows.push({
      id: crypto.randomUUID(),
      dispatch_run_id: this.ctx.dispatch_run_id!,
      campaign_id: clamp(this.ctx.campaign_id, ID_MAX),
      program_id: clamp(this.ctx.program_id, ID_MAX),
      step_id: this.ctx.step_id,
      organization_id: this.ctx.organization_id,
      user_id: clamp(entry.user_id, ID_MAX),
      channel: this.ctx.channel,
      provider: this.ctx.provider,
      template_ref: this.ctx.template_ref,
      status: entry.status,
      provider_message_id: entry.provider_message_id
        ? clamp(entry.provider_message_id, ID_MAX)
        : null,
      latency_ms: entry.latency_ms ?? null,
      error_category: entry.error_category ? clamp(entry.error_category, ID_MAX) : null,
      error_message: entry.error_message ? clamp(entry.error_message, ERROR_MAX) : null,
      fallbacks_used: entry.fallbacks_used ?? null,
      occurred_at: new Date(),
    });
  }

  /** Fire-and-forget by design — awaiting this would put bookkeeping on the send path. */
  flush(): void {
    if (this.rows.length === 0) return;
    const batch = this.rows.splice(0, this.rows.length);
    void insertSendLogs(batch).catch((error: unknown) => {
      log.warn(
        { err: error instanceof Error ? error : new Error(String(error)) },
        `Failed to persist ${batch.length} send log rows`
      );
    });
  }
}
