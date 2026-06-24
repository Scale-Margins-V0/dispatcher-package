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

function sendgridSigningEnvName(cfg: EventsConfig): string {
  return cfg.providers.sendgrid.signing_key_env ?? "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY";
}

function gupshupSecretEnvName(cfg: EventsConfig): string {
  return cfg.providers.gupshup.secret_env ?? "GUPSHUP_WEBHOOK_SECRET";
}

/** Comma-separated provider names → normalized set. */
function parseProviderList(raw: string | undefined): Array<"sendgrid" | "ses" | "gupshup"> {
  if (!raw?.trim()) {
    return [];
  }
  const out: Array<"sendgrid" | "ses" | "gupshup"> = [];
  for (const token of raw.split(",")) {
    const t = token.trim().toLowerCase();
    if (t === "sendgrid" || t === "ses" || t === "gupshup") {
      out.push(t);
    }
  }
  return out;
}

/**
 * One source of truth for provider on/off: env keys + EVENT_PROVIDERS_DISABLED / EVENT_PROVIDERS_ENABLED.
 * Overrides YAML `enabled` so operators don't need a separate events.yaml for inbound.
 */
export function applyProviderEnablementFromEnv(cfg: EventsConfig): void {
  const sgEnv = sendgridSigningEnvName(cfg);
  const guEnv = gupshupSecretEnvName(cfg);
  cfg.providers.sendgrid.enabled = Boolean(process.env[sgEnv]?.trim());
  cfg.providers.ses.enabled = true;
  // `enabled` here gates FORWARDING to the backend event caller — default off.
  // The Gupshup webhook endpoint always accepts + logs payloads regardless; it only
  // forwards when this is on. Turn on later via GUPSHUP_WEBHOOK_SECRET or
  // EVENT_PROVIDERS_ENABLED=gupshup.
  cfg.providers.gupshup.enabled = Boolean(process.env[guEnv]?.trim());

  for (const p of parseProviderList(process.env.EVENT_PROVIDERS_DISABLED)) {
    cfg.providers[p].enabled = false;
  }
  const forceOn = parseProviderList(process.env.EVENT_PROVIDERS_ENABLED);
  if (forceOn.length > 0) {
    for (const p of forceOn) {
      cfg.providers[p].enabled = true;
    }
  }
}

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

export function isEventDebug(): boolean {
  const v = process.env.EVENT_DEBUG?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Safe summary for boot logs (no secrets). */
export function logResolvedEventsConfig(cfg: EventsConfig): void {
  if (!isEventDebug()) {
    return;
  }
  console.log(
    "[Events] resolved config:",
    JSON.stringify({
      forward: cfg.forward,
      delivery: {
        mode: cfg.delivery.mode,
        buffer: { kind: cfg.delivery.buffer.kind, max_events_memory: cfg.delivery.buffer.max_events_memory },
      },
      providers: {
        sendgrid: { enabled: cfg.providers.sendgrid.enabled, signing_key_env: cfg.providers.sendgrid.signing_key_env },
        ses: { enabled: cfg.providers.ses.enabled },
        gupshup: { enabled: cfg.providers.gupshup.enabled, secret_env: cfg.providers.gupshup.secret_env },
      },
    })
  );
}

export function loadEventsConfigFromYaml(content: string): EventsConfig {
  const parsed = yaml.load(content) as unknown;
  return eventsSchema.parse(parsed).events;
}

export function mergeEventsEnvOverrides(cfg: EventsConfig): void {
  const fm = process.env.EVENT_FORWARD_MODE;
  if (fm === "sync" || fm === "batched") {
    cfg.forward.mode = fm;
  }
  const dm = process.env.EVENT_DELIVERY_MODE;
  if (dm === "at_least_once" || dm === "best_effort") {
    cfg.delivery.mode = dm;
  }
  const bs = process.env.EVENT_BATCH_SIZE;
  if (bs && !Number.isNaN(Number(bs))) {
    cfg.forward.batch_size = Number(bs);
  }
  const bi = process.env.EVENT_BATCH_INTERVAL_MS;
  if (bi && !Number.isNaN(Number(bi))) {
    cfg.forward.batch_interval_ms = Number(bi);
  }
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

  applyProviderEnablementFromEnv(cfg);
}

export function loadEventsConfig(): EventsConfig {
  if (cached) {
    return cached;
  }
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
    const k = sendgridSigningEnvName(cfg);
    if (!process.env[k]?.trim()) {
      throw new Error(`[events] SendGrid enabled but ${k} is not set`);
    }
  }
  if (cfg.providers.gupshup.enabled) {
    const s = gupshupSecretEnvName(cfg);
    if (!process.env[s]?.trim()) {
      console.warn(
        `[events] Gupshup inbound webhook is OPEN — ${s} is not set, so incoming ` +
          `signatures are NOT verified. POST /api/scalemargin/gupshup-events accepts ` +
          `unauthenticated payloads.`
      );
    }
  }
}

export function resetEventsConfigForTests(): void {
  cached = null;
}

export function setEventsConfigForTests(cfg: EventsConfig): void {
  cached = cfg;
}
