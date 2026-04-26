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
import { createGupshupInboundAdapter } from "./gupshup/adapter.js";
import { logPreferenceSideEffectSimulation } from "./preference-side-effect-log.js";
import { resolveAnalyticsCallbackUrl } from "./resolve-analytics-callback-url.js";
import { scrubPii } from "./scrubber.js";
import { createSendGridInboundAdapter } from "./sendgrid/adapter.js";
import { sendGridInboundWireAllowed } from "./sendgrid/inbound-filter.js";
import { createSesInboundAdapter } from "./ses/adapter.js";

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
        console.warn(
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

async function drainAndFlushAll(): Promise<void> {
  const buf = getBuffer();
  const secret = getSecret();
  const drained: EventEnvelope[] = [];
  while (buf.size() > 0) {
    drained.push(...buf.drain(5000));
  }
  if (drained.length > 0) {
    if (isEventDebug()) {
      console.log(`[Events] flush start size=${drained.length}`);
    }
    const r = await flushEnvelopesSync(drained, secret);
    if (isEventDebug()) {
      if (r.ok) {
        console.log(`[Events] flush ok size=${drained.length}`);
      } else {
        console.warn(`[Events] flush err size=${drained.length} errors=${r.errors.join("; ")}`);
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
  getBuffer();
  const cfg = runtimeConfig;
  if (cfg.forward.mode === "batched") {
    flusherTimer = setInterval(() => {
      void (async () => {
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
  if (isEventDebug()) {
    const ev = envelope.event;
    console.log(
      `[Events] emit campaign=${ev.campaign_id} user=${ev.user_id} event=${ev.event} provider=${ev.provider} messageId=${ev.provider_message_id}`
    );
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
    const secret = process.env[envName];
    if (!secret)
      {throw new Error(`Missing ${envName} for Gupshup inbound adapter`);}
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
      res.status(401).json({ error: "invalid signature" });
      return;
    }

    let items: unknown[];
    try {
      items = adapter.parseEvents(rawBody);
    } catch {
      res.status(400).json({ error: "invalid webhook payload" });
      return;
    }
    const envelopes: EventEnvelope[] = [];
    const cfg = getRuntimeConfig();
    let sendgridUncorrelated = 0;
    let sendgridUncorrelatedSample: unknown = null;
    let skippedInboundWire = 0;
    let droppedNoCallbackUrl = 0;
    let droppedUnsupported = 0;
    let droppedOtherNoCorrelation = 0;
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
        } else {
          droppedOtherNoCorrelation++;
          console.warn(
            `[Events][${adapter.name}] Dropping event — missing correlation fields`
          );
        }
        continue;
      }
      const url = resolveAnalyticsCallbackUrl({
        campaignId: c.campaign_id,
        correlationCallbackUrl: c.analytics_callback_url,
      });
      if (!url) {
        droppedNoCallbackUrl++;
        console.warn(
          `[Events][${adapter.name}] Dropping event — no analytics_callback_url, no campaign registry entry, and no valid SCALEMARGIN_ANALYTICS_CALLBACK_URL for ${c.campaign_id}`
        );
        continue;
      }
      const fullC = { ...c, analytics_callback_url: url };
      const stripped = adapter.stripPii(item);
      const std = adapter.toStandardEvent(stripped, fullC);
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
      envelopes.push({ callbackUrl: url, event: std });
    }

    const sampleWireEvent =
      sendgridUncorrelatedSample &&
      typeof sendgridUncorrelatedSample === "object" &&
      sendgridUncorrelatedSample !== null &&
      "event" in sendgridUncorrelatedSample
        ? String((sendgridUncorrelatedSample as { event?: unknown }).event ?? "")
        : "";
    console.log(
      `[Events][${adapter.name}] inbound rawCount=${items.length} filtered_wire=${skippedInboundWire} forwarded=${envelopes.length} dropped_sg_no_correlation=${sendgridUncorrelated} dropped_no_callback_url=${droppedNoCallbackUrl} dropped_unsupported=${droppedUnsupported} dropped_other_no_correlation=${droppedOtherNoCorrelation}`
    );
    if (sendgridUncorrelated > 0) {
      console.warn(
        `[Events][sendgrid] Dropped ${sendgridUncorrelated} webhook event(s) — missing correlation. sample_wire_event=${sampleWireEvent || "n/a"} — ` +
          explainSendGridCorrelationDrop(sendgridUncorrelatedSample)
      );
    }

    if (cfg.forward.mode === "sync") {
      if (isEventDebug() && envelopes.length > 0) {
        console.log(`[Events] flush start size=${envelopes.length} (inbound sync)`);
      }
      const flushResult = await flushEnvelopesSync(envelopes, getSecret());
      if (isEventDebug() && envelopes.length > 0) {
        if (flushResult.ok) {
          console.log(`[Events] flush ok size=${envelopes.length} (inbound sync)`);
        } else {
          console.warn(
            `[Events] flush err size=${envelopes.length} (inbound sync) errors=${flushResult.errors.join("; ")}`
          );
        }
      }
    } else {
      for (const env of envelopes) {
        getBuffer().push(env);
      }
    }

    res.status(200).json({ received: true, count: envelopes.length });
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
