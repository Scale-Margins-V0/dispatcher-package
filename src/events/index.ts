import type { Request, Response, RequestHandler } from "express";

import type {
  EventBuffer,
  EventEnvelope,
  InboundEventAdapter,
  StandardizedEvent,
} from "./common/types.js";

import { createEventBuffer } from "./buffer.js";
import { explainSendGridCorrelationDrop } from "./common/correlator.js";
import {
  assertEventsConfigEnv,
  isEventDebug,
  loadEventsConfig,
  logResolvedEventsConfig,
  mergeEventsEnvOverrides,
  resetEventsConfigForTests,
  setEventsConfigForTests,
  type EventsConfig,
} from "./config.js";
import { flushEnvelopesSync, buildIdempotencyKey } from "./forwarder.js";
import {
  createGupshupInboundAdapter,
  extractGupshupReceipt,
  type GupshupReceipt,
} from "./gupshup/adapter.js";
import { forwardGupshupReceipts } from "./gupshup/receipt-forwarder.js";
import { isDbInitialized } from "../db/client.js";
import { deliverDueBatch, enqueueEvents } from "./outbox.js";
import { componentLogger } from "../logging/logger.js";
import { persistCampaignEvents } from "./persist.js";
import { logPreferenceSideEffectSimulation } from "./preference-side-effect-log.js";
import { resolveAnalyticsCallbackUrl } from "./resolve-analytics-callback-url.js";
import { scrubPii } from "./scrubber.js";
import { createSendGridInboundAdapter } from "./sendgrid/adapter.js";
import { sendGridInboundWireAllowed } from "./sendgrid/inbound-filter.js";
import { createSesInboundAdapter } from "./ses/adapter.js";
import { telemetry } from "../telemetry/posthog.js";

const log = componentLogger("events");

let buffer: EventBuffer | null = null;
let runtimeConfig: EventsConfig | null = null;
let flusherTimer: ReturnType<typeof setInterval> | undefined;
let pipelineInitialized = false;

function getSecret(): string {
  return process.env.SCALEMARGIN_ANALYTICS_SECRET || "";
}

function getRuntimeConfig(): EventsConfig {
  if (!runtimeConfig) {
    runtimeConfig = loadEventsConfig();
    mergeEventsEnvOverrides(runtimeConfig);
  }
  return runtimeConfig;
}

function getBuffer(): EventBuffer {
  if (!buffer) {
    const cfg = getRuntimeConfig();
    buffer = createEventBuffer({
      kind: cfg.delivery.buffer.kind === "disk" ? "disk" : "memory",
      diskDir: cfg.delivery.buffer.dir,
      memoryMaxSize: cfg.delivery.buffer.max_events_memory,
      onDropOldest: () => {
        log.warn(
          "[EventsBuffer] Ring full — dropped oldest envelope (best-effort / overflow)"
        );
      },
    });
  }
  return buffer;
}

function ensureIdempotency(event: StandardizedEvent): void {
  const cfg = getRuntimeConfig();
  if (cfg.delivery.mode === "at_least_once" && !event.idempotency_key) {
    event.idempotency_key = buildIdempotencyKey(
      event.provider,
      event.provider_message_id,
      event.event,
      event.occurred_at
    );
  }
}

/** Outbox is the durable buffer; the in-memory ring is a fallback for when the state DB is unavailable (e.g. unit tests without a DB). */
function outboxActive(): boolean {
  return isDbInitialized();
}

const OUTBOX_FLUSH_LIMIT = 5000;

async function drainAndFlushAll(): Promise<void> {
  const buf = getBuffer();
  const secret = getSecret();
  const drained: EventEnvelope[] = [];
  while (buf.size() > 0) {
    drained.push(...buf.drain(5000));
  }
  if (drained.length > 0) {
    if (isEventDebug()) {
      log.info(`[Events] flush start size=${drained.length}`);
    }
    const r = await flushEnvelopesSync(drained, secret);
    if (isEventDebug()) {
      if (r.ok) {
        log.info(`[Events] flush ok size=${drained.length}`);
      } else {
        log.warn(`[Events] flush err size=${drained.length} errors=${r.errors.join("; ")}`);
      }
    }
  }
}

/**
 * Start the event pipeline (buffer, optional batched flusher, env validation).
 * Safe to call once at process startup.
 */
export function initializeEventPipeline(): void {
  if (pipelineInitialized) {return;}
  runtimeConfig = loadEventsConfig();
  mergeEventsEnvOverrides(runtimeConfig);
  assertEventsConfigEnv(runtimeConfig);
  logResolvedEventsConfig(runtimeConfig);
  if (!outboxActive()) getBuffer();
  const cfg = runtimeConfig;
  if (cfg.forward.mode === "batched") {
    flusherTimer = setInterval(() => {
      void (async () => {
        if (outboxActive()) {
          await deliverDueBatch(cfg.forward.batch_size, getSecret());
          return;
        }
        const batch = getBuffer().drain(cfg.forward.batch_size);
        if (batch.length === 0) {return;}
        await flushEnvelopesSync(batch, getSecret());
      })();
    }, cfg.forward.batch_interval_ms);
  }
  pipelineInitialized = true;
}

export function shutdownEventPipeline(): void {
  if (flusherTimer) {
    clearInterval(flusherTimer);
    flusherTimer = undefined;
  }
  if (buffer) {void drainAndFlushAll();}
  pipelineInitialized = false;
}

/**
 * Emit a standardized event from the dispatch send path (or tests).
 */
export async function emitEvent(envelope: EventEnvelope): Promise<void> {
  const cfg = getRuntimeConfig();
  ensureIdempotency(envelope.event);
  // Console store first: dispatch-side events are recorded even when the
  // callback URL is empty and forwarding later fails validation.
  await persistCampaignEvents([envelope.event]);
  if (isEventDebug()) {
    const ev = envelope.event;
    log.info(
      `[Events] emit campaign=${ev.campaign_id} user=${ev.user_id} event=${ev.event} provider=${ev.provider} messageId=${ev.provider_message_id}`
    );
  }
  if (outboxActive()) {
    await enqueueEvents([envelope]);
    if (cfg.forward.mode === "sync") {
      await deliverDueBatch(OUTBOX_FLUSH_LIMIT, getSecret());
    }
    return;
  }
  getBuffer().push(envelope);
  if (cfg.forward.mode === "sync") {
    await drainAndFlushAll();
  }
}

export function getInboundAdapter(
  name: "sendgrid" | "ses" | "gupshup"
): InboundEventAdapter {
  const cfg = getRuntimeConfig();
  if (name === "sendgrid") {
    const envName =
      cfg.providers.sendgrid.signing_key_env ??
      "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY";
    const key = process.env[envName];
    if (!key)
      {throw new Error(`Missing ${envName} for SendGrid inbound adapter`);}
    return createSendGridInboundAdapter(key);
  }
  if (name === "ses") {
    return createSesInboundAdapter();
  }
  if (name === "gupshup") {
    const envName =
      cfg.providers.gupshup.secret_env ?? "GUPSHUP_WEBHOOK_SECRET";
    // Secret optional: when unset the adapter skips signature verification (open webhook).
    const secret = process.env[envName] ?? "";
    return createGupshupInboundAdapter(secret);
  }
  throw new Error(`Unknown adapter: ${name}`);
}

export function isProviderEnabled(
  name: "sendgrid" | "ses" | "gupshup"
): boolean {
  return getRuntimeConfig().providers[name].enabled;
}

/**
 * Express handler factory for provider event webhooks.
 */
export function createInboundWebhookHandler(
  adapter: InboundEventAdapter,
  enabled: boolean
): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    if (!enabled) {
      telemetry.capture("dispatcher_provider_webhook_disabled", {
        provider: adapter.name,
      });
      res.status(404).json({ error: "not found" });
      return;
    }
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : typeof req.body === "string"
        ? Buffer.from(req.body, "utf8")
        : Buffer.from(JSON.stringify(req.body ?? {}), "utf8");

    const ok = await Promise.resolve(
      adapter.verifySignature({
        rawBody,
        headers: req.headers as Record<string, string | string[] | undefined>,
      })
    );
    if (!ok) {
      telemetry.capture("dispatcher_provider_webhook_signature_failed", {
        provider: adapter.name,
      });
      res.status(401).json({ error: "invalid signature" });
      return;
    }

    let items: unknown[];
    try {
      items = adapter.parseEvents(rawBody);
    } catch (error) {
      telemetry.captureException(error, {
        component: "provider_webhook_parse",
        provider: adapter.name,
      });
      res.status(400).json({ error: "invalid webhook payload" });
      return;
    }
    const envelopes: EventEnvelope[] = [];
    const standardized: StandardizedEvent[] = [];
    const gupshupReceipts: GupshupReceipt[] = [];
    const cfg = getRuntimeConfig();
    let sendgridUncorrelated = 0;
    let sendgridUncorrelatedSample: unknown = null;
    let skippedInboundWire = 0;
    let persistedNotForwarded = 0;
    let droppedUnsupported = 0;
    let droppedOtherNoCorrelation = 0;
    let droppedUnsignedReceipts = 0;
    for (const item of items) {
      if (adapter.name === "sendgrid") {
        if (
          !sendGridInboundWireAllowed(
            item,
            cfg.providers.sendgrid.inbound_event_types
          )
        ) {
          skippedInboundWire++;
          continue;
        }
      }
      const c = adapter.extractCorrelation(item);
      if (!c) {
        if (adapter.name === "sendgrid") {
          sendgridUncorrelated++;
          if (sendgridUncorrelated === 1) {sendgridUncorrelatedSample = item;}
        } else if (adapter.name === "gupshup") {
          // GatewayAPI delivery receipts carry no tag — forward them to the backend,
          // which matches externalId → the dispatched event's metadata.provider_message_id.
          // Require our authenticity stamp: a receipt whose echoed `extra` is missing
          // or not `smsign_…` is rejected here and never forwarded.
          const receipt = extractGupshupReceipt(item);
          if (receipt && receipt.sign) {
            gupshupReceipts.push(receipt);
          } else if (receipt) {
            droppedUnsignedReceipts++;
            console.warn(
              `[Events][gupshup] Rejecting receipt externalId=${receipt.external_id} — extra missing or not smsign_ (unauthenticated)`
            );
          } else {
            droppedOtherNoCorrelation++;
            log.warn(
              `[Events][gupshup] Dropping event — missing correlation and not a forwardable receipt`
            );
          }
        } else {
          droppedOtherNoCorrelation++;
          log.warn(
            `[Events][${adapter.name}] Dropping event — missing correlation fields`
          );
        }
        continue;
      }
      // Standardize + persist BEFORE the callback-URL gate: the console
      // records every correlated event; only *forwarding* needs a URL.
      const stripped = adapter.stripPii(item);
      const std = adapter.toStandardEvent(stripped, c);
      if (!std) {
        droppedUnsupported++;
        if (adapter.name === "gupshup") {
          const status =
            typeof stripped.eventType === "string"
              ? stripped.eventType
              : typeof stripped.status === "string"
                ? stripped.status
                : "unknown";
          console.warn(
            `[Events][gupshup] Dropping event — unsupported status mapping: ${status}`
          );
        }
        continue;
      }
      ensureIdempotency(std);
      if (std.metadata) {
        std.metadata = scrubPii(std.metadata) as StandardizedEvent["metadata"];
      }
      logPreferenceSideEffectSimulation(std);
      standardized.push(std);
      const url = resolveAnalyticsCallbackUrl({
        campaignId: c.campaign_id,
        correlationCallbackUrl: c.analytics_callback_url,
      });
      if (!url) {
        persistedNotForwarded++;
        log.warn(
          `[Events][${adapter.name}] Not forwarding event — no analytics_callback_url, no campaign registry entry, and no valid SCALEMARGIN_ANALYTICS_CALLBACK_URL for ${c.campaign_id}; recorded in the console only`
        );
        continue;
      }
      std.analytics_callback_url = url;
      envelopes.push({ callbackUrl: url, event: std });
    }

    if (standardized.length > 0) {
      await persistCampaignEvents(standardized);
    }

    const sampleWireEvent =
      sendgridUncorrelatedSample &&
      typeof sendgridUncorrelatedSample === "object" &&
      sendgridUncorrelatedSample !== null &&
      "event" in sendgridUncorrelatedSample
        ? String((sendgridUncorrelatedSample as { event?: unknown }).event ?? "")
        : "";
    log.info(
      `[Events][${adapter.name}] inbound rawCount=${items.length} filtered_wire=${skippedInboundWire} persisted=${standardized.length} forwarded=${envelopes.length} receipts=${gupshupReceipts.length} dropped_sg_no_correlation=${sendgridUncorrelated} persisted_not_forwarded=${persistedNotForwarded} dropped_unsupported=${droppedUnsupported} dropped_other_no_correlation=${droppedOtherNoCorrelation} dropped_unsigned_receipts=${droppedUnsignedReceipts}`
    );
    if (sendgridUncorrelated > 0) {
      log.warn(
        `[Events][sendgrid] Dropped ${sendgridUncorrelated} webhook event(s) — missing correlation. sample_wire_event=${sampleWireEvent || "n/a"} — ` +
          explainSendGridCorrelationDrop(sendgridUncorrelatedSample)
      );
    }

    if (outboxActive()) {
      // Durable: persist before delivering so a restart mid-flight loses nothing.
      if (envelopes.length > 0) await enqueueEvents(envelopes);
      if (cfg.forward.mode === "sync" && envelopes.length > 0) {
        await deliverDueBatch(Math.max(OUTBOX_FLUSH_LIMIT, envelopes.length), getSecret());
      }
    } else if (cfg.forward.mode === "sync") {
      if (isEventDebug() && envelopes.length > 0) {
        log.info(`[Events] flush start size=${envelopes.length} (inbound sync)`);
      }
      const flushResult = await flushEnvelopesSync(envelopes, getSecret());
      if (!flushResult.ok) {
        telemetry.capture("dispatcher_analytics_forward_failed", {
          provider: adapter.name,
          event_count: envelopes.length,
          error_count: flushResult.errors.length,
        });
      }
      if (isEventDebug() && envelopes.length > 0) {
        if (flushResult.ok) {
          log.info(`[Events] flush ok size=${envelopes.length} (inbound sync)`);
        } else {
          log.warn(
            `[Events] flush err size=${envelopes.length} (inbound sync) errors=${flushResult.errors.join("; ")}`
          );
        }
      }
    } else {
      for (const env of envelopes) {
        getBuffer().push(env);
      }
    }

    // Correlation-free WhatsApp delivery receipts are matched on the backend by
    // externalId, so they bypass the campaign-keyed analytics pipeline entirely.
    if (gupshupReceipts.length > 0) {
      await forwardGupshupReceipts(gupshupReceipts, getSecret());
    }

    res.status(200).json({
      received: true,
      count: envelopes.length,
      receipts: gupshupReceipts.length,
    });
  };
}

export function resetEventPipelineForTests(): void {
  shutdownEventPipeline();
  resetEventsConfigForTests();
  buffer = null;
  runtimeConfig = null;
  pipelineInitialized = false;
}

export { setEventsConfigForTests, loadEventsConfig, mergeEventsEnvOverrides };
export type { EventsConfig };
