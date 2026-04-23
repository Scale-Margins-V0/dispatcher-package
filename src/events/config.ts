import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

const providerBlock = z.object({
  enabled: z.boolean(),
  signing_key_env: z.string().optional(),
  configuration_set_env: z.string().optional(),
  secret_env: z.string().optional(),
  /**
   * SendGrid Event Webhook payload `event` field (wire names: processed, delivered, open, …).
   * Omit or [] → default minimal set (see sendgrid-inbound-filter.ts).
   * `["*"]` → all wire values we know how to map.
   */
  inbound_event_types: z.array(z.string()).optional(),
});

const eventsSchema = z.object({
  events: z.object({
    forward: z.object({
      mode: z.enum(["batched", "sync"]),
      batch_size: z.number().int().positive().default(100),
      batch_interval_ms: z.number().int().positive().default(5000),
    }),
    delivery: z.object({
      mode: z.enum(["at_least_once", "best_effort"]),
      buffer: z.object({
        kind: z.enum(["memory", "disk"]),
        dir: z.string().optional(),
        max_events_memory: z.number().int().positive().default(10_000),
      }),
    }),
    providers: z.object({
      sendgrid: providerBlock,
      ses: providerBlock,
      gupshup: providerBlock,
    }),
  }),
});

export type EventsConfig = z.infer<typeof eventsSchema>["events"];

let cached: EventsConfig | null = null;

function defaultConfig(): EventsConfig {
  return {
    forward: {
      mode: "batched",
      batch_size: 100,
      batch_interval_ms: 5000,
    },
    delivery: {
      mode: "at_least_once",
      buffer: {
        kind: "memory",
        max_events_memory: 10_000,
      },
    },
    providers: {
      sendgrid: { enabled: false, signing_key_env: "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY" },
      ses: { enabled: true, configuration_set_env: "SES_EVENT_CONFIG_SET" },
      gupshup: { enabled: false, secret_env: "GUPSHUP_WEBHOOK_SECRET" },
    },
  };
}

export function loadEventsConfigFromYaml(content: string): EventsConfig {
  const parsed = yaml.load(content) as unknown;
  return eventsSchema.parse(parsed).events;
}

export function mergeEventsEnvOverrides(cfg: EventsConfig): void {
  const fm = process.env.EVENT_FORWARD_MODE;
  if (fm === "sync" || fm === "batched") cfg.forward.mode = fm;
  const dm = process.env.EVENT_DELIVERY_MODE;
  if (dm === "at_least_once" || dm === "best_effort") cfg.delivery.mode = dm;
  const bs = process.env.EVENT_BATCH_SIZE;
  if (bs && !Number.isNaN(Number(bs))) cfg.forward.batch_size = Number(bs);
  const bi = process.env.EVENT_BATCH_INTERVAL_MS;
  if (bi && !Number.isNaN(Number(bi))) cfg.forward.batch_interval_ms = Number(bi);
  const bufDir = process.env.EVENT_BUFFER_DIR;
  if (bufDir) {
    cfg.delivery.buffer.kind = "disk";
    cfg.delivery.buffer.dir = bufDir;
  }

  const sgInbound = process.env.EVENT_SENDGRID_INBOUND_EVENTS?.trim();
  if (sgInbound !== undefined) {
    if (sgInbound === "" || /^default$/i.test(sgInbound)) {
      cfg.providers.sendgrid.inbound_event_types = undefined;
    } else if (sgInbound === "*" || /^all$/i.test(sgInbound)) {
      cfg.providers.sendgrid.inbound_event_types = ["*"];
    } else {
      cfg.providers.sendgrid.inbound_event_types = sgInbound
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
}

export function loadEventsConfig(): EventsConfig {
  if (cached) return cached;
  const path = process.env.EVENTS_CONFIG_PATH || resolve(process.cwd(), "config", "events.yaml");
  if (!existsSync(path)) {
    cached = defaultConfig();
    mergeEventsEnvOverrides(cached);
    return cached;
  }
  const raw = readFileSync(path, "utf-8");
  cached = loadEventsConfigFromYaml(raw);
  mergeEventsEnvOverrides(cached);
  return cached;
}

/**
 * Validate enabled providers have required secrets / env (fatal on boot).
 */
export function assertEventsConfigEnv(cfg: EventsConfig): void {
  if (cfg.providers.sendgrid.enabled) {
    const k = cfg.providers.sendgrid.signing_key_env ?? "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY";
    if (!process.env[k]) {
      throw new Error(`[events] SendGrid enabled but ${k} is not set`);
    }
  }
  if (cfg.providers.gupshup.enabled) {
    const s = cfg.providers.gupshup.secret_env ?? "GUPSHUP_WEBHOOK_SECRET";
    if (!process.env[s]) {
      throw new Error(`[events] Gupshup enabled but ${s} is not set`);
    }
  }
}

export function resetEventsConfigForTests(): void {
  cached = null;
}

export function setEventsConfigForTests(cfg: EventsConfig): void {
  cached = cfg;
}
