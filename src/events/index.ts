import type { Request, Response, RequestHandler } from "express";
import { getCampaignCallback } from "./campaign-callback-registry.js";
import { createEventBuffer } from "./buffer.js";
import {
  assertEventsConfigEnv,
  loadEventsConfig,
  mergeEventsEnvOverrides,
  resetEventsConfigForTests,
  setEventsConfigForTests,
  type EventsConfig,
} from "./config.js";
import { flushEnvelopesSync, buildIdempotencyKey } from "./forwarder.js";
import { scrubPii } from "./scrubber.js";
import type { EventBuffer, EventEnvelope, InboundEventAdapter, StandardizedEvent } from "./common/types.js";
import { createSendGridInboundAdapter } from "./sendgrid/adapter.js";
import { createSesInboundAdapter } from "./ses/adapter.js";
import { createGupshupInboundAdapter } from "./gupshup/adapter.js";
import { sendGridInboundWireAllowed } from "./sendgrid/inbound-filter.js";
import { explainSendGridCorrelationDrop } from "./common/correlator.js";
import { logPreferenceSideEffectSimulation } from "./preference-side-effect-log.js";

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
        console.warn("[EventsBuffer] Ring full — dropped oldest envelope (best-effort / overflow)");
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
    await flushEnvelopesSync(drained, secret);
  }
}

/**
 * Start the event pipeline (buffer, optional batched flusher, env validation).
 * Safe to call once at process startup.
 */
export function initializeEventPipeline(): void {
  if (pipelineInitialized) return;
  runtimeConfig = loadEventsConfig();
  mergeEventsEnvOverrides(runtimeConfig);
  assertEventsConfigEnv(runtimeConfig);
  getBuffer();
  const cfg = runtimeConfig;
  if (cfg.forward.mode === "batched") {
    flusherTimer = setInterval(() => {
      void (async () => {
        const batch = getBuffer().drain(cfg.forward.batch_size);
        if (batch.length === 0) return;
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
  if (buffer) void drainAndFlushAll();
  pipelineInitialized = false;
}

/**
 * Emit a standardized event from the dispatch send path (or tests).
 */
export async function emitEvent(envelope: EventEnvelope): Promise<void> {
  const cfg = getRuntimeConfig();
  ensureIdempotency(envelope.event);
  getBuffer().push(envelope);
  if (cfg.forward.mode === "sync") {
    await drainAndFlushAll();
  }
}

export function getInboundAdapter(name: "sendgrid" | "ses" | "gupshup"): InboundEventAdapter {
  const cfg = getRuntimeConfig();
  if (name === "sendgrid") {
    const envName = cfg.providers.sendgrid.signing_key_env ?? "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY";
    const key = process.env[envName];
    if (!key) throw new Error(`Missing ${envName} for SendGrid inbound adapter`);
    return createSendGridInboundAdapter(key);
  }
  if (name === "ses") {
    return createSesInboundAdapter();
  }
  if (name === "gupshup") {
    const envName = cfg.providers.gupshup.secret_env ?? "GUPSHUP_WEBHOOK_SECRET";
    const secret = process.env[envName];
    if (!secret) throw new Error(`Missing ${envName} for Gupshup inbound adapter`);
    return createGupshupInboundAdapter(secret);
  }
  throw new Error(`Unknown adapter: ${name}`);
}

export function isProviderEnabled(name: "sendgrid" | "ses" | "gupshup"): boolean {
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
        ? Buffer.from(req.body, "utf-8")
        : Buffer.from(JSON.stringify(req.body ?? {}), "utf-8");

    const ok = await Promise.resolve(
      adapter.verifySignature({ rawBody, headers: req.headers as Record<string, string | string[] | undefined> })
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
    for (const item of items) {
      if (adapter.name === "sendgrid") {
        if (
          !sendGridInboundWireAllowed(item, cfg.providers.sendgrid.inbound_event_types)
        ) {
          continue;
        }
      }
      const c = adapter.extractCorrelation(item);
      if (!c) {
        if (adapter.name === "sendgrid") {
          sendgridUncorrelated++;
          if (sendgridUncorrelated === 1) sendgridUncorrelatedSample = item;
        } else {
          console.warn(`[Events][${adapter.name}] Dropping event — missing correlation fields`);
        }
        continue;
      }
      const url =
        c.analytics_callback_url ?? getCampaignCallback(c.campaign_id)?.analytics_callback_url;
      if (!url) {
        console.warn(
          `[Events][${adapter.name}] Dropping event — no analytics_callback_url and no campaign registry entry for ${c.campaign_id}`
        );
        continue;
      }
      const fullC = { ...c, analytics_callback_url: url };
      const stripped = adapter.stripPii(item);
      const std = adapter.toStandardEvent(stripped, fullC);
      if (!std) {
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

    if (sendgridUncorrelated > 0) {
      console.warn(
        `[Events][sendgrid] Dropped ${sendgridUncorrelated} webhook event(s) — missing correlation. ` +
          explainSendGridCorrelationDrop(sendgridUncorrelatedSample)
      );
    }

    if (cfg.forward.mode === "sync") {
      await flushEnvelopesSync(envelopes, getSecret());
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
