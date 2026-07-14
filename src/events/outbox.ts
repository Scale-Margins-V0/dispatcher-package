/**
 * Durable analytics event outbox — replaces the in-memory/disk event buffers.
 * Events are persisted before delivery, so a restart mid-flight loses nothing;
 * the outbox owns retry (exponential backoff with a cap), and inline provider
 * retries are disabled so the DB is the single source of retry truth.
 *
 * Single-replica assumption: no row claim tokens. A second replica would need
 * claimed_by/claimed_at to avoid double-delivery.
 */

import { isDbInitialized } from "../db/client.js";
import {
  enqueueOutbox,
  markOutboxDelivered,
  markOutboxDelivering,
  markOutboxFailedAttempt,
  selectDueOutbox,
} from "../db/repos/outbox.js";
import type { OutboxRow } from "../db/schema/index.js";
import { componentLogger } from "../logging/logger.js";
import type { EventEnvelope, StandardizedEvent } from "./common/types.js";
import { buildPayloadForGroup, postAnalyticsWithRetry } from "./forwarder.js";

const log = componentLogger("events.outbox");

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 60 * 60 * 1000; // 60 minutes
/** While a batch is in flight, don't re-pick it for this long. */
const DELIVERING_LEASE_MS = 5 * 60 * 1000;

function maxAttempts(): number {
  const parsed = parseInt(process.env.DISPATCHER_OUTBOX_MAX_ATTEMPTS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

function backoffFor(attempts: number): number {
  const raw = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);
  // +/-15% jitter so retries don't thunder together (not for security).
  const jitter = raw * 0.15 * (0.5 - deterministicJitterSeed(attempts));
  return Math.round(raw + jitter);
}

// Avoids Math.random (unavailable in some sandboxes); spreads by attempt count.
function deterministicJitterSeed(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export async function enqueueEvents(envelopes: EventEnvelope[]): Promise<void> {
  if (envelopes.length === 0) return;
  await enqueueOutbox(
    envelopes.map((envelope) => ({
      callback_url: envelope.callbackUrl,
      campaign_id: envelope.event.campaign_id,
      organization_id: envelope.event.organization_id,
      event: envelope.event as unknown as Record<string, unknown>,
      idempotency_key: envelope.event.idempotency_key ?? "",
    }))
  );
}

type OutboxGroup = {
  callbackUrl: string;
  campaign_id: string;
  organization_id: string;
  events: StandardizedEvent[];
  ids: string[];
  /** Highest pre-delivery attempt count across the group's rows. */
  maxAttempts: number;
};

/** Group due rows by destination, keeping each row id so we settle exactly those rows. */
function groupDueRows(rows: OutboxRow[]): OutboxGroup[] {
  const groups = new Map<string, OutboxGroup>();
  for (const row of rows) {
    const key = `${row.callback_url} ${row.campaign_id} ${row.organization_id}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        callbackUrl: row.callback_url,
        campaign_id: row.campaign_id,
        organization_id: row.organization_id,
        events: [],
        ids: [],
        maxAttempts: 0,
      };
      groups.set(key, group);
    }
    group.events.push(row.event as unknown as StandardizedEvent);
    group.ids.push(row.id);
    group.maxAttempts = Math.max(group.maxAttempts, row.attempts);
  }
  return [...groups.values()];
}

/**
 * Deliver due rows (grouped by destination). Rows in a group succeed or fail
 * together; the DB idempotency_key dedupes any re-delivered event downstream.
 */
export async function deliverDueBatch(
  limit: number,
  secret: string,
  now: Date = new Date()
): Promise<{ delivered: number; failed: number }> {
  if (!isDbInitialized()) return { delivered: 0, failed: 0 };
  const due = await selectDueOutbox(limit, now);
  if (due.length === 0) return { delivered: 0, failed: 0 };

  await markOutboxDelivering(
    due.map((row) => row.id),
    DELIVERING_LEASE_MS,
    now
  );

  let delivered = 0;
  let failed = 0;
  const limitAttempts = maxAttempts();

  for (const group of groupDueRows(due)) {
    const payload = buildPayloadForGroup({
      campaign_id: group.campaign_id,
      organization_id: group.organization_id,
      events: group.events,
    });
    // maxRetries 0: the outbox owns retry, not the inline POST loop.
    const result = await postAnalyticsWithRetry(group.callbackUrl, payload, secret, 0);
    if (result.success) {
      await markOutboxDelivered(group.ids, new Date());
      delivered += group.ids.length;
    } else {
      const attempts = group.maxAttempts + 1;
      const terminal = attempts >= limitAttempts;
      await markOutboxFailedAttempt(group.ids, {
        lastError: result.error ?? "delivery failed",
        nextAttemptAt: new Date(now.getTime() + backoffFor(attempts)),
        terminal,
      });
      failed += group.ids.length;
      if (terminal) {
        log.warn(
          { campaign_id: group.campaign_id, attempts },
          `Outbox events exhausted retries for ${group.callbackUrl}`
        );
      }
    }
  }

  return { delivered, failed };
}
