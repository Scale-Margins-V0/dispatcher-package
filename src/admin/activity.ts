/**
 * Operational activity, persisted in the state DB (dispatch_runs /
 * webhook_activity / dispatch_recipient_failures). The record* functions keep
 * their sync signatures — writes are fire-and-forget so the dispatch path
 * never blocks on bookkeeping.
 */

import {
  getActivitySnapshot,
  insertRecipientFailure,
  insertWebhookActivity,
  upsertDispatchRun,
} from "../db/repos/activity.js";
import { isDbInitialized } from "../db/state.js";
import type {
  DispatchRunRow,
  WebhookActivityRow,
  WebhookDirection,
  WebhookStatus,
} from "../db/schema/index.js";
import { componentLogger } from "../logging/logger.js";

const log = componentLogger("admin.activity");

export type DispatchActivity = {
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
};

export type WebhookActivity = {
  id: string;
  provider: string;
  direction: WebhookDirection;
  status: WebhookStatus;
  event_count: number;
  http_status?: number;
  duration_ms?: number;
  attempt?: number;
  occurred_at: string;
  destination?: string;
  error_category?: string;
  error_message?: string;
};

export type RecipientFailure = {
  dispatch_run_id: string;
  campaign_id: string;
  user_id: string;
  provider: string;
  error_category: string;
  error_message: string;
  error_stack?: string;
  context?: Record<string, unknown>;
};

const safeId = (value: string): string =>
  value.length <= 80 ? value : `${value.slice(0, 77)}...`;

const swallow = (what: string) => (error: unknown) => {
  log.warn(
    { err: error instanceof Error ? error : new Error(String(error)) },
    `Failed to persist ${what}`
  );
};

export const recordDispatchActivity = (activity: DispatchActivity): void => {
  if (!isDbInitialized()) return;
  const run: Omit<DispatchRunRow, "updated_at"> = {
    id: activity.id,
    campaign_id: safeId(activity.campaign_id),
    organization_id: activity.organization_id ?? null,
    channel: activity.channel,
    provider: activity.provider,
    status: activity.status,
    recipient_count: activity.recipient_count,
    sent_count: activity.sent_count ?? null,
    failed_count: activity.failed_count ?? null,
    duration_ms: activity.duration_ms ?? null,
    error_category: activity.error_category ?? null,
    error_message: activity.error_message ?? null,
    error_stack: activity.error_stack ?? null,
    occurred_at: new Date(activity.occurred_at),
  };
  void upsertDispatchRun(run).catch(swallow("dispatch activity"));
};

export const recordWebhookActivity = (activity: WebhookActivity): void => {
  if (!isDbInitialized()) return;
  const row: WebhookActivityRow = {
    id: activity.id,
    provider: activity.provider,
    direction: activity.direction,
    status: activity.status,
    event_count: activity.event_count,
    http_status: activity.http_status ?? null,
    duration_ms: activity.duration_ms ?? null,
    attempt: activity.attempt ?? null,
    destination: activity.destination ?? null,
    error_category: activity.error_category ?? null,
    error_message: activity.error_message ?? null,
    occurred_at: new Date(activity.occurred_at),
  };
  void insertWebhookActivity(row).catch(swallow("webhook activity"));
};

/** Per-recipient failure with the real error text — feeds the dispatch detail view. */
export const recordRecipientFailure = (failure: RecipientFailure): void => {
  if (!isDbInitialized()) return;
  void insertRecipientFailure({
    id: crypto.randomUUID(),
    dispatch_run_id: failure.dispatch_run_id,
    campaign_id: safeId(failure.campaign_id),
    user_id: failure.user_id,
    provider: failure.provider,
    error_category: failure.error_category,
    error_message: failure.error_message,
    error_stack: failure.error_stack ?? null,
    context: failure.context ?? null,
    occurred_at: new Date(),
  }).catch(swallow("recipient failure"));
};

export const redactDestination = (value: string): string => {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid destination";
  }
};

const runToActivity = (run: DispatchRunRow): DispatchActivity => ({
  id: run.id,
  campaign_id: run.campaign_id,
  organization_id: run.organization_id ?? undefined,
  channel: run.channel,
  provider: run.provider,
  status: run.status,
  recipient_count: run.recipient_count,
  sent_count: run.sent_count ?? undefined,
  failed_count: run.failed_count ?? undefined,
  duration_ms: run.duration_ms ?? undefined,
  occurred_at: run.occurred_at.toISOString(),
  error_category: run.error_category ?? undefined,
  error_message: run.error_message ?? undefined,
  error_stack: run.error_stack ?? undefined,
});

const webhookToActivity = (row: WebhookActivityRow): WebhookActivity => ({
  id: row.id,
  provider: row.provider,
  direction: row.direction,
  status: row.status,
  event_count: row.event_count,
  http_status: row.http_status ?? undefined,
  duration_ms: row.duration_ms ?? undefined,
  attempt: row.attempt ?? undefined,
  occurred_at: row.occurred_at.toISOString(),
  destination: row.destination ?? undefined,
  error_category: row.error_category ?? undefined,
  error_message: row.error_message ?? undefined,
});

export const getAdminActivity = async () => {
  const snapshot = await getActivitySnapshot();
  return {
    scope: {
      retention: "persistent",
      retention_windows: { activity_days: 90 },
      started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    },
    summary: snapshot.summary,
    dispatches: snapshot.dispatches.map(runToActivity),
    failures: snapshot.failures.map((item) =>
      "recipient_count" in item
        ? runToActivity(item as DispatchRunRow)
        : webhookToActivity(item as WebhookActivityRow)
    ),
    webhooks: snapshot.webhooks.map(webhookToActivity),
  };
};
