/**
 * AsyncLocalStorage log context: request_id / campaign_id ride along the async
 * chain, and the pino mixin stamps them onto every line — no logger threading.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type LogContext = { request_id?: string; campaign_id?: string };

export const logContext = new AsyncLocalStorage<LogContext>();

export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  return logContext.run(ctx, fn);
}

/** Attach a campaign id to the current request's context (no-op outside one). */
export function bindCampaignId(campaignId: string): void {
  const store = logContext.getStore();
  if (store) store.campaign_id = campaignId;
}
