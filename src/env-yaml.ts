import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { z } from "zod";
import { LogComponent } from "./logging/conventions.js";
import { componentLogger } from "./logging/logger.js";
import type {
  SenderConfig,
  SenderRoutingConfig,
} from "./providers/types.js";

const log = componentLogger(LogComponent.config);

const sesConfigSchema = z.object({
  region: z.string().optional(),
  configuration_set: z.string().optional(),
  access_key_id: z.string().optional(),
  access_key_id_env: z.string().optional(),
  secret_access_key: z.string().optional(),
  secret_access_key_env: z.string().optional(),
});

const sendgridConfigSchema = z.object({
  api_key: z.string().optional(),
  api_key_env: z.string().optional(),
  event_webhook_public_key: z.string().optional(),
  event_webhook_public_key_env: z.string().optional(),
});

const gupshupConfigSchema = z.object({
  mode: z.enum(["api_key", "enterprise"]).optional(),
  api_key: z.string().optional(),
  api_key_env: z.string().optional(),
  user_id: z.string().optional(),
  user_id_env: z.string().optional(),
  password: z.string().optional(),
  password_env: z.string().optional(),
  src_name: z.string().optional(),
  source: z.string().optional(),
  default_template: z.string().optional(),
  template_language: z.string().optional(),
  message_type: z.string().optional(),
  webhook_secret: z.string().optional(),
  webhook_secret_env: z.string().optional(),
  template_api_url: z.string().optional(),
  enterprise_api_url: z.string().optional(),
  media_api_url: z.string().optional(),
});

const freshchatConfigSchema = z.object({
  api_key: z.string().optional(),
  api_key_env: z.string().optional(),
  api_endpoint: z.string().optional(),
  api_endpoint_env: z.string().optional(),
  namespace: z.string().optional(),
  namespace_env: z.string().optional(),
  from_number: z.string().optional(),
  from_number_env: z.string().optional(),
  default_template: z.string().optional(),
  default_template_json: z.string().optional(),
});

const senderFailoverSchema = z.object({
  enabled: z.boolean().optional(),
  max_attempts: z.number().int().positive().optional(),
  on_timeout: z.boolean().optional(),
  on_identity_error: z.boolean().optional(),
});

const senderSchema = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, "Sender id must be an alphanumeric slug"),
  channel: z.enum(["email", "whatsapp"]),
  provider: z.enum(["ses", "sendgrid", "gupshup", "freshchat"]),
  organizations: z.array(z.string().min(1)).optional(),
  from: z.string().optional(),
  reply_to: z.string().optional(),
  weight: z.number().nonnegative().default(1),
  enabled: z.boolean().default(true),
  failover: senderFailoverSchema.optional(),
  ses: sesConfigSchema.optional(),
  sendgrid: sendgridConfigSchema.optional(),
  gupshup: gupshupConfigSchema.optional(),
  freshchat: freshchatConfigSchema.optional(),
});

const routingFailoverSchema = z.object({
  max_attempts: z.number().int().positive().default(2),
  on_timeout: z.boolean().default(false),
  on_identity_error: z.boolean().default(false),
  breaker: z
    .object({
      failure_threshold: z.number().int().positive().default(5),
      cooldown_ms: z.number().int().positive().default(60000),
    })
    .optional(),
});

const routingSchema = z.object({
  failover: routingFailoverSchema.optional(),
  default_sender: z
    .object({
      email: z.string().optional(),
      whatsapp: z.string().optional(),
    })
    .optional(),
});

export const envYamlSchema = z.object({
  version: z.literal(1).optional(),
  routing: routingSchema.optional(),
  senders: z.array(senderSchema).default([]),
});

export type EnvYaml = z.infer<typeof envYamlSchema>;

let cachedEnvYaml: EnvYaml | null = null;
let cachedEnvYamlPath: string | null = null;

/**
 * Resolves repository root based on import.meta.url
 */
function resolveModuleRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Returns candidate paths for .env.yaml in priority order:
 * 1. ENV_YAML_PATH
 * 2. <module root>/.env.yaml
 * 3. cwd/.env.yaml
 */
export function envYamlPath(): string | null {
  if (cachedEnvYamlPath !== null) {
    return cachedEnvYamlPath;
  }
  const explicit = process.env.ENV_YAML_PATH?.trim();
  if (explicit && existsSync(explicit)) {
    cachedEnvYamlPath = resolve(explicit);
    return cachedEnvYamlPath;
  }

  // Under vitest, ignore disk .env.yaml so tests are hermetic unless explicitly injected
  if (process.env.VITEST === "true") {
    return null;
  }

  const moduleRoot = resolve(resolveModuleRoot(), ".env.yaml");
  if (existsSync(moduleRoot)) {
    cachedEnvYamlPath = moduleRoot;
    return cachedEnvYamlPath;
  }

  const cwdPath = resolve(process.cwd(), ".env.yaml");
  if (existsSync(cwdPath)) {
    cachedEnvYamlPath = cwdPath;
    return cachedEnvYamlPath;
  }

  cachedEnvYamlPath = null;
  return null;
}

/**
 * Synthesize a default EnvYaml object from existing environment variables.
 */
export function synthesizeBackCompatEnvYaml(): EnvYaml {
  const emailProvider = (process.env.EMAIL_PROVIDER || "ses").toLowerCase() as "ses" | "sendgrid";
  const fromEmail = process.env.FROM_EMAIL || "noreply@example.com";

  const emailSender: SenderConfig = {
    id: "default-email",
    channel: "email",
    provider: emailProvider,
    organizations: ["*"],
    from: fromEmail,
    weight: 1,
    enabled: true,
    ses: {
      region: process.env.AWS_REGION,
      configuration_set: process.env.SES_EVENT_CONFIG_SET || process.env.SES_CONFIGURATION_SET,
      ...(process.env.AWS_ACCESS_KEY_ID ? { access_key_id_env: "AWS_ACCESS_KEY_ID" } : {}),
      ...(process.env.AWS_SECRET_ACCESS_KEY ? { secret_access_key_env: "AWS_SECRET_ACCESS_KEY" } : {}),
    },
    sendgrid: {
      api_key_env: "SENDGRID_API_KEY",
      event_webhook_public_key_env: "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY",
    },
  };

  const senders: EnvYaml["senders"] = [emailSender as EnvYaml["senders"][number]];

  const waProvider = process.env.WHATSAPP_PROVIDER?.toLowerCase();
  const hasFreshchat = Boolean(process.env.FRESHCHAT_API_KEY);
  const hasGupshup = Boolean(
    process.env.GUPSHUP_API_KEY ||
      (process.env.GUPSHUP_USER_ID && process.env.GUPSHUP_PASSWORD)
  );

  let defaultWaId: string | undefined = undefined;

  if (waProvider === "freshchat" || (hasFreshchat && !hasGupshup)) {
    defaultWaId = "default-freshchat";
    senders.push({
      id: "default-freshchat",
      channel: "whatsapp",
      provider: "freshchat",
      organizations: ["*"],
      from: process.env.FRESHCHAT_FROM_NUMBER,
      weight: 1,
      enabled: true,
      freshchat: {
        api_key_env: "FRESHCHAT_API_KEY",
        api_endpoint_env: "FRESHCHAT_OUTBOUND_MESSAGES_URL",
        namespace_env: "FRESHCHAT_NAMESPACE",
        from_number_env: "FRESHCHAT_FROM_NUMBER",
        default_template:
          process.env.FRESHCHAT_DEFAULT_TEMPLATE || process.env.FRESHCHAT_EVENT_TEST_TEMPLATE,
      },
    });
  } else if (hasGupshup) {
    defaultWaId = "default-wa";
    const isApiKey = Boolean(process.env.GUPSHUP_API_KEY);
    senders.push({
      id: "default-wa",
      channel: "whatsapp",
      provider: "gupshup",
      organizations: ["*"],
      weight: 1,
      enabled: true,
      gupshup: {
        mode: isApiKey ? "api_key" : "enterprise",
        api_key_env: "GUPSHUP_API_KEY",
        user_id_env: "GUPSHUP_USER_ID",
        password_env: "GUPSHUP_PASSWORD",
        src_name: process.env.GUPSHUP_SRC_NAME || process.env.GUPSHUP_EVENT_TEST_SRC_NAME,
        source: process.env.GUPSHUP_SOURCE || process.env.GUPSHUP_EVENT_TEST_SOURCE,
        default_template:
          process.env.GUPSHUP_DEFAULT_TEMPLATE || process.env.GUPSHUP_EVENT_TEST_TEMPLATE,
        template_language: process.env.GUPSHUP_TEMPLATE_LANGUAGE || "en",
        message_type: process.env.GUPSHUP_MESSAGE_TYPE || "HSM",
        webhook_secret_env: "GUPSHUP_WEBHOOK_SECRET",
      },
    });
  }

  return {
    version: 1,
    routing: {
      failover: {
        max_attempts: 2,
        on_timeout: false,
        on_identity_error: false,
      },
      default_sender: {
        email: "default-email",
        ...(defaultWaId ? { whatsapp: defaultWaId } : {}),
      },
    },
    senders,
  };
}

export function loadEnvYaml(): EnvYaml {
  if (cachedEnvYaml) {
    return cachedEnvYaml;
  }
  const filePath = envYamlPath();
  if (!filePath) {
    cachedEnvYaml = synthesizeBackCompatEnvYaml();
    if (process.env.VITEST !== "true") {
      log.info(
        { env_yaml_present: false },
        "No .env.yaml found — using single-sender back-compat configuration from environment"
      );
    }
    return cachedEnvYaml;
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = yaml.load(raw);
    const validated = envYamlSchema.parse(parsed);

    // If senders array is empty, fall back to back-compat
    if (validated.senders.length === 0) {
      cachedEnvYaml = synthesizeBackCompatEnvYaml();
      return cachedEnvYaml;
    }

    cachedEnvYaml = validated;
    if (process.env.VITEST !== "true") {
      log.info(
        { path: filePath, sender_count: validated.senders.length },
        "Loaded .env.yaml multi-sender configuration"
      );
    }
    return cachedEnvYaml;
  } catch (error) {
    throw new Error(
      `Failed to parse .env.yaml at ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Fatal validation at boot time
 */
export function ensureEnvYamlValid(): void {
  const filePath = envYamlPath();
  const cfg = loadEnvYaml();

  if (filePath && process.env.VITEST !== "true") {
    try {
      const stats = statSync(filePath);
      // Mode checks: warn if group or world readable/writable (0o077) on POSIX
      if ((stats.mode & 0o077) !== 0 && process.platform !== "win32") {
        log.warn(
          { path: filePath },
          ".env.yaml has overly permissive file permissions (group/world readable). Consider chmod 600 .env.yaml"
        );
      }
    } catch {
      /* ignore stat error */
    }
  }

  const seenIds = new Set<string>();
  const seenFromEmails = new Set<string>();

  for (const sender of cfg.senders) {
    // 1. Unique ID
    if (seenIds.has(sender.id)) {
      throw new Error(`[env.yaml] Duplicate sender id '${sender.id}' found`);
    }
    seenIds.add(sender.id);

    // 2. Channel & Provider alignment
    if (sender.channel === "email" && sender.provider !== "ses" && sender.provider !== "sendgrid") {
      throw new Error(`[env.yaml] Email sender '${sender.id}' cannot use provider '${sender.provider}'`);
    }
    if (sender.channel === "whatsapp" && sender.provider !== "gupshup" && sender.provider !== "freshchat") {
      throw new Error(`[env.yaml] WhatsApp sender '${sender.id}' cannot use provider '${sender.provider}'`);
    }

    // 3. Unique From address for email
    if (sender.channel === "email" && sender.from) {
      const lower = sender.from.trim().toLowerCase();
      if (seenFromEmails.has(lower)) {
        throw new Error(`[env.yaml] Duplicate from address '${sender.from}' in sender '${sender.id}'`);
      }
      seenFromEmails.add(lower);
    }

    // 4. Validate credentials presence for enabled senders
    if (sender.enabled === false) {
      continue;
    }

    if (sender.provider === "ses" && sender.ses) {
      if (sender.ses.access_key_id && sender.ses.access_key_id_env) {
        log.warn(`[env.yaml] Sender '${sender.id}' specifies both access_key_id and access_key_id_env; inline wins`);
      }
      if (!sender.ses.access_key_id && sender.ses.access_key_id_env && !process.env[sender.ses.access_key_id_env]?.trim()) {
        throw new Error(
          `[env.yaml] Sender '${sender.id}' references missing env var '${sender.ses.access_key_id_env}'`
        );
      }
      if (!sender.ses.secret_access_key && sender.ses.secret_access_key_env && !process.env[sender.ses.secret_access_key_env]?.trim()) {
        throw new Error(
          `[env.yaml] Sender '${sender.id}' references missing env var '${sender.ses.secret_access_key_env}'`
        );
      }
      if (!sender.ses.configuration_set && process.env.VITEST !== "true") {
        log.warn(
          `[env.yaml] SES sender '${sender.id}' has no configuration_set specified — SNS tracking events will not be emitted`
        );
      }
    }

    if (sender.provider === "sendgrid") {
      const sg = sender.sendgrid;
      const inlineKey = sg?.api_key?.trim();
      const envKeyName = sg?.api_key_env?.trim();
      const envVal = envKeyName ? process.env[envKeyName]?.trim() : undefined;

      if (!inlineKey && !envVal) {
        throw new Error(
          `[env.yaml] SendGrid sender '${sender.id}' requires an API key (api_key or valid api_key_env)`
        );
      }
    }

    if (sender.provider === "gupshup") {
      const g = sender.gupshup;
      const mode = g?.mode || "api_key";
      if (mode === "api_key") {
        const key = g?.api_key?.trim() || (g?.api_key_env ? process.env[g.api_key_env]?.trim() : undefined);
        if (!key) {
          throw new Error(
            `[env.yaml] Gupshup API key sender '${sender.id}' requires api_key or valid api_key_env`
          );
        }
      } else if (mode === "enterprise") {
        const user = g?.user_id?.trim() || (g?.user_id_env ? process.env[g.user_id_env]?.trim() : undefined);
        const pass = g?.password?.trim() || (g?.password_env ? process.env[g.password_env]?.trim() : undefined);
        if (!user || !pass) {
          throw new Error(
            `[env.yaml] Gupshup Enterprise sender '${sender.id}' requires user_id and password`
          );
        }
      }
    }

    if (sender.provider === "freshchat") {
      const fc = sender.freshchat;
      const key = fc?.api_key?.trim() || (fc?.api_key_env ? process.env[fc.api_key_env]?.trim() : undefined);
      if (!key) {
        throw new Error(
          `[env.yaml] Freshchat sender '${sender.id}' requires api_key or valid api_key_env`
        );
      }
      const fromNumber =
        fc?.from_number?.trim() ||
        (fc?.from_number_env ? process.env[fc.from_number_env]?.trim() : undefined) ||
        sender.from?.trim() ||
        process.env.FRESHCHAT_FROM_NUMBER?.trim();
      if (!fromNumber) {
        throw new Error(
          `[env.yaml] Freshchat sender '${sender.id}' requires from_number or from address`
        );
      }
    }
  }

  // 5. Default senders resolution check
  const defEmail = cfg.routing?.default_sender?.email;
  if (defEmail) {
    const match = cfg.senders.find((s) => s.id === defEmail && s.channel === "email" && s.enabled);
    if (!match) {
      throw new Error(`[env.yaml] default_sender.email '${defEmail}' not found or disabled`);
    }
  }

  const defWa = cfg.routing?.default_sender?.whatsapp;
  if (defWa) {
    const match = cfg.senders.find((s) => s.id === defWa && s.channel === "whatsapp" && s.enabled);
    if (!match) {
      throw new Error(`[env.yaml] default_sender.whatsapp '${defWa}' not found or disabled`);
    }
  }
}

export function resetEnvYamlForTests(): void {
  cachedEnvYaml = null;
  cachedEnvYamlPath = null;
}

export function setEnvYamlForTests(yaml: EnvYaml): void {
  cachedEnvYaml = envYamlSchema.parse(yaml);
}
