import { createHash } from "node:crypto";
import { loadEnvYaml } from "../env-yaml.js";
import { LogComponent } from "../logging/conventions.js";
import { componentLogger } from "../logging/logger.js";
import { GupshupWhatsAppProvider, gupshupConfigFromSender } from "./gupshup-whatsapp.js";
import { FreshchatWhatsAppProvider, freshchatConfigFromSender } from "./freshchat-whatsapp.js";
import { SendGridProvider } from "./sendgrid.js";
import { SESProvider } from "./ses.js";
import type {
  EmailMessage,
  EmailProvider,
  SendAttempt,
  Sender,
  SenderChannel,
  SenderConfig,
  SendResult,
} from "./types.js";

const log = componentLogger(LogComponent.providers);

/**
 * Circuit Breaker State per Sender
 */
interface BreakerState {
  failures: number;
  state: "closed" | "open" | "half-open";
  lastFailureAt: number;
  failureThreshold: number;
  cooldownMs: number;
}

class SenderRegistry {
  private senders: Map<string, Sender> = new Map();
  private breakers: Map<string, BreakerState> = new Map();
  private initialized = false;

  public init(): void {
    if (this.initialized) return;
    this.reload();
    this.initialized = true;
  }

  public reload(): void {
    this.senders.clear();
    const envYaml = loadEnvYaml();
    const globalBreakerCfg = envYaml.routing?.failover?.breaker;
    const defaultThreshold = globalBreakerCfg?.failure_threshold ?? 5;
    const defaultCooldown = globalBreakerCfg?.cooldown_ms ?? 60000;

    for (const cfg of envYaml.senders) {
      if (cfg.enabled === false) continue;
      const provider = this.instantiateProvider(cfg);
      this.senders.set(cfg.id, { config: cfg, provider });

      if (!this.breakers.has(cfg.id)) {
        this.breakers.set(cfg.id, {
          failures: 0,
          state: "closed",
          lastFailureAt: 0,
          failureThreshold: defaultThreshold,
          cooldownMs: defaultCooldown,
        });
      }
    }
  }

  private instantiateProvider(cfg: SenderConfig): EmailProvider | GupshupWhatsAppProvider | FreshchatWhatsAppProvider {
    if (cfg.channel === "email") {
      if (cfg.provider === "sendgrid") {
        const apiKey =
          cfg.sendgrid?.api_key?.trim() ||
          (cfg.sendgrid?.api_key_env ? process.env[cfg.sendgrid.api_key_env]?.trim() : undefined) ||
          process.env.SENDGRID_API_KEY;
        return new SendGridProvider(apiKey);
      }
      // SES provider
      const region = cfg.ses?.region || process.env.AWS_REGION || "ap-south-1";
      const accessKeyId =
        cfg.ses?.access_key_id?.trim() ||
        (cfg.ses?.access_key_id_env ? process.env[cfg.ses.access_key_id_env]?.trim() : undefined);
      const secretAccessKey =
        cfg.ses?.secret_access_key?.trim() ||
        (cfg.ses?.secret_access_key_env ? process.env[cfg.ses.secret_access_key_env]?.trim() : undefined);
      const configurationSet =
        cfg.ses?.configuration_set ||
        process.env.SES_EVENT_CONFIG_SET ||
        process.env.SES_CONFIGURATION_SET;
      return new SESProvider({
        region,
        accessKeyId,
        secretAccessKey,
        configurationSet,
      });
    }

    // WhatsApp
    if (cfg.provider === "freshchat") {
      const freshchatCfg = freshchatConfigFromSender(cfg);
      return new FreshchatWhatsAppProvider(freshchatCfg);
    }

    const gupshupCfg = gupshupConfigFromSender(cfg);
    return new GupshupWhatsAppProvider(gupshupCfg);
  }

  public getAllSenders(): Sender[] {
    this.init();
    return Array.from(this.senders.values());
  }

  public getSender(id: string): Sender | undefined {
    this.init();
    return this.senders.get(id);
  }

  public getBreakerState(senderId: string): BreakerState | undefined {
    return this.breakers.get(senderId);
  }

  public isBreakerAvailable(senderId: string): boolean {
    const breaker = this.breakers.get(senderId);
    if (!breaker) return true;

    if (breaker.state === "closed") return true;

    const now = Date.now();
    if (breaker.state === "open") {
      if (now - breaker.lastFailureAt >= breaker.cooldownMs) {
        breaker.state = "half-open";
        return true;
      }
      return false;
    }

    // half-open allows 1 probe
    return true;
  }

  public recordSuccess(senderId: string): void {
    const breaker = this.breakers.get(senderId);
    if (breaker) {
      if (breaker.state !== "closed") {
        log.info({ sender_id: senderId }, `Circuit breaker for sender '${senderId}' reset to closed`);
      }
      breaker.failures = 0;
      breaker.state = "closed";
    }
  }

  public recordFailure(senderId: string, tripsBreaker: boolean): void {
    if (!tripsBreaker) return;
    const breaker = this.breakers.get(senderId);
    if (!breaker) return;

    breaker.failures += 1;
    breaker.lastFailureAt = Date.now();

    if (breaker.failures >= breaker.failureThreshold) {
      breaker.state = "open";
      log.warn(
        { sender_id: senderId, failures: breaker.failures, cooldown_ms: breaker.cooldownMs },
        `Circuit breaker opened for sender '${senderId}' (${breaker.failures} consecutive failures)`
      );
    }
  }

  public resetForTests(): void {
    this.senders.clear();
    this.breakers.clear();
    this.initialized = false;
  }
}

export const registry = new SenderRegistry();

/**
 * 64-bit BigInt hash from SHA-256
 */
export function hash64(input: string): bigint {
  const buf = createHash("sha256").update(input).digest();
  return buf.readBigUInt64BE(0);
}

/**
 * Weighted Rendezvous Hashing (HRW) score for a given (userId, senderId, weight).
 * score = - weight / ln(u), where u in (0, 1]
 */
export function hrwScore(userId: string, senderId: string, weight: number): number {
  if (weight <= 0) return -1;
  const h = hash64(`${userId}:${senderId}`);
  // Map to (0, 1]
  const u = Number(h) / 18446744073709551616; // 2^64
  const clampedU = u === 0 ? 1e-15 : u;
  return -weight / Math.log(clampedU);
}

/**
 * Orders candidate senders for a recipient using HRW.
 */
export function orderForRecipient(userId: string, senders: Sender[]): Sender[] {
  const weighted = senders.filter((s) => (s.config.weight ?? 1) > 0);
  if (weighted.length <= 1) {
    return weighted;
  }

  return [...weighted].sort((a, b) => {
    const scoreA = hrwScore(userId, a.config.id, a.config.weight ?? 1);
    const scoreB = hrwScore(userId, b.config.id, b.config.weight ?? 1);
    return scoreB - scoreA;
  });
}

/**
 * Error classification mapping
 */
export interface ErrorClassification {
  failover: boolean;
  trips_breaker: boolean;
  category: string;
}

export function classifyError(error: unknown, channel: string): ErrorClassification {
  const msg = error instanceof Error ? error.message : String(error || "");
  const lower = msg.toLowerCase();
  const envYaml = loadEnvYaml();
  const failoverCfg = envYaml.routing?.failover;
  const onTimeout = failoverCfg?.on_timeout ?? false;
  const onIdentityError = failoverCfg?.on_identity_error ?? false;

  // 1. Timeouts
  if (
    lower.includes("etimedout") ||
    lower.includes("esockettimedout") ||
    lower.includes("und_err_headers_timeout") ||
    lower.includes("timeout") ||
    lower.includes("timed out")
  ) {
    return {
      failover: onTimeout,
      trips_breaker: true,
      category: "network_timeout",
    };
  }

  // 2. Transient network errors
  if (
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("eai_again") ||
    lower.includes("und_err_socket") ||
    lower.includes("fetch failed") ||
    lower.includes("network error") ||
    lower.includes("socket hang up")
  ) {
    return {
      failover: true,
      trips_breaker: true,
      category: "network_transient",
    };
  }

  // 3. Throttling / Rate limiting
  if (
    lower.includes("429") ||
    lower.includes("too many requests") ||
    lower.includes("throttling") ||
    lower.includes("throttlingexception") ||
    lower.includes("provisionedthroughputexceededexception") ||
    lower.includes("rate limit")
  ) {
    return {
      failover: true,
      trips_breaker: true,
      category: "rate_limited",
    };
  }

  // 4. Provider 5xx server errors
  if (
    lower.includes("500") ||
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("504") ||
    lower.includes("internal server error") ||
    lower.includes("bad gateway") ||
    lower.includes("service unavailable") ||
    lower.includes("gateway timeout")
  ) {
    return {
      failover: true,
      trips_breaker: true,
      category: "provider_5xx",
    };
  }

  // 5. Auth / credentials failures
  if (
    lower.includes("invalidclienttokenid") ||
    lower.includes("signaturedoesnotmatch") ||
    lower.includes("the security token included in the request is invalid") ||
    lower.includes("authorization_required") ||
    lower.includes("bad credentials") ||
    (lower.includes("401") && lower.includes("unauthorized"))
  ) {
    return {
      failover: true,
      trips_breaker: true,
      category: "auth_failure",
    };
  }

  // 6. Unverified Sender Identity
  if (
    lower.includes("email address is not verified") ||
    lower.includes("domain is not verified") ||
    lower.includes("does not match a verified sender identity")
  ) {
    return {
      failover: onIdentityError,
      trips_breaker: true,
      category: "unverified_sender",
    };
  }

  // 7. Permanent / terminal errors
  return {
    failover: false,
    trips_breaker: false,
    category: "terminal_error",
  };
}

/**
 * Check if a sender matches an organization
 */
export function senderMatchesOrg(sender: SenderConfig, orgId: string): boolean {
  if (!sender.organizations || sender.organizations.length === 0) {
    return true;
  }
  return sender.organizations.includes("*") || sender.organizations.includes(orgId);
}

export interface SenderPin {
  sender_id?: string;
  from_email?: string;
  sender_strict?: boolean;
}

export interface SynchronousPinResult {
  ok: boolean;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Validates pins and org authorization synchronously before returning 202 Accepted.
 */
export function resolveSenderPin(payload: {
  channel: string;
  metadata?: {
    organization_id?: string;
    sender_id?: string;
    from_email?: string;
    sender_strict?: boolean;
  };
}): SynchronousPinResult {
  registry.init();
  const allSenders = registry.getAllSenders();
  const orgId = payload.metadata?.organization_id || "";
  const channel = String(payload.channel || "email").toLowerCase() as SenderChannel;

  // 1. Pinned sender_id
  if (payload.metadata?.sender_id) {
    const senderId = payload.metadata.sender_id.trim();
    const sender = registry.getSender(senderId);
    if (!sender) {
      return {
        ok: false,
        error: {
          code: "unknown_sender_id",
          message: `Sender '${senderId}' does not exist or is disabled`,
        },
      };
    }
    if (sender.config.channel !== channel) {
      return {
        ok: false,
        error: {
          code: "invalid_sender_channel",
          message: `Sender '${senderId}' is configured for channel '${sender.config.channel}', not '${channel}'`,
        },
      };
    }
    if (!senderMatchesOrg(sender.config, orgId)) {
      return {
        ok: false,
        error: {
          code: "sender_org_forbidden",
          message: `Sender '${senderId}' is not authorized for organization '${orgId}'`,
        },
      };
    }
    return { ok: true };
  }

  // 2. Pinned from_email (for email channel)
  if (payload.metadata?.from_email && channel === "email") {
    const from = payload.metadata.from_email.trim().toLowerCase();
    const matching = allSenders.find(
      (s) => s.config.channel === "email" && s.config.from?.trim().toLowerCase() === from
    );
    if (!matching) {
      return {
        ok: false,
        error: {
          code: "unknown_from_email",
          message: `No email sender configured with From address '${payload.metadata.from_email}'`,
        },
      };
    }
    if (!senderMatchesOrg(matching.config, orgId)) {
      return {
        ok: false,
        error: {
          code: "sender_org_forbidden",
          message: `From address '${payload.metadata.from_email}' is not authorized for organization '${orgId}'`,
        },
      };
    }
    return { ok: true };
  }

  // 3. Organization has at least one candidate sender
  const orgCandidates = allSenders.filter(
    (s) => s.config.channel === channel && senderMatchesOrg(s.config, orgId)
  );

  if (orgCandidates.length === 0) {
    return {
      ok: false,
      error: {
        code: "no_sender_for_organization",
        message: `No enabled sender configured for channel '${channel}' and organization '${orgId}'`,
      },
    };
  }

  return { ok: true };
}

/**
 * Resolves the ordered candidate chain for a recipient.
 */
export function resolveSenderChainForRecipient(
  userId: string,
  rawChannel: string,
  orgId: string,
  pin?: SenderPin
): Sender[] {
  const channel = String(rawChannel || "email").toLowerCase() as SenderChannel;
  registry.init();
  const allSenders = registry.getAllSenders();

  // 1. Pinned sender_id
  if (pin?.sender_id) {
    const sender = registry.getSender(pin.sender_id.trim());
    if (sender && sender.config.channel === channel && senderMatchesOrg(sender.config, orgId)) {
      if (pin.sender_strict === false) {
        const fallbacks = allSenders.filter(
          (s) =>
            s.config.id !== sender.config.id &&
            s.config.channel === channel &&
            senderMatchesOrg(s.config, orgId) &&
            registry.isBreakerAvailable(s.config.id)
        );
        return [sender, ...orderForRecipient(userId, fallbacks)];
      }
      return [sender];
    }
  }

  // 2. Pinned from_email
  if (pin?.from_email && channel === "email") {
    const from = pin.from_email.trim().toLowerCase();
    const sender = allSenders.find(
      (s) => s.config.channel === "email" && s.config.from?.trim().toLowerCase() === from
    );
    if (sender && senderMatchesOrg(sender.config, orgId)) {
      if (pin.sender_strict === false) {
        const fallbacks = allSenders.filter(
          (s) =>
            s.config.id !== sender.config.id &&
            s.config.channel === channel &&
            senderMatchesOrg(s.config, orgId) &&
            registry.isBreakerAvailable(s.config.id)
        );
        return [sender, ...orderForRecipient(userId, fallbacks)];
      }
      return [sender];
    }
  }

  // 3. Automatic selection: filter candidates by channel and org
  const matching = allSenders.filter(
    (s) => s.config.channel === channel && senderMatchesOrg(s.config, orgId)
  );

  if (matching.length === 0) {
    return [];
  }

  // Prefer healthy senders where breaker is available
  const healthy = matching.filter((s) => registry.isBreakerAvailable(s.config.id));
  const pool = healthy.length > 0 ? healthy : matching;

  return orderForRecipient(userId, pool);
}

export interface SendWithFailoverResult {
  success: boolean;
  finalSender: Sender;
  attempts: SendAttempt[];
  messageId?: string;
  error?: string;
  error_category?: string;
}

/**
 * Orchestrates sending via candidate chain with failover and circuit breaker tracking.
 */
export async function sendWithFailover(
  message: EmailMessage | any,
  chain: Sender[],
  channel: SenderChannel,
  maxAttemptsOverride?: number
): Promise<SendWithFailoverResult> {
  if (chain.length === 0) {
    throw new Error(`No available senders for channel '${channel}'`);
  }

  const envYaml = loadEnvYaml();
  const maxAttempts =
    maxAttemptsOverride ??
    chain[0]?.config.failover?.max_attempts ??
    envYaml.routing?.failover?.max_attempts ??
    2;

  const attempts: SendAttempt[] = [];
  const limit = Math.min(chain.length, maxAttempts);

  let finalSender = chain[0]!;
  let lastResult: SendResult = { success: false, error: "No attempt executed" };
  let lastCategory = "unknown";

  for (let i = 0; i < limit; i++) {
    const sender = chain[i]!;
    finalSender = sender;
    const attemptIndex = i + 1;

    // For email, override from and replyTo from sender config if set
    let sendMsg = message;
    if (channel === "email") {
      const emailMsg = message as EmailMessage;
      sendMsg = {
        ...emailMsg,
        from: sender.config.from || emailMsg.from,
        ...(sender.config.reply_to ? { replyTo: sender.config.reply_to } : {}),
      };
    }

    const start = Date.now();
    try {
      const result: SendResult = await sender.provider.send(sendMsg);
      const durationMs = Date.now() - start;

      if (result.success) {
        registry.recordSuccess(sender.config.id);
        attempts.push({
          sender_id: sender.config.id,
          attempt: attemptIndex,
          provider: sender.config.provider,
          success: true,
          duration_ms: durationMs,
        });

        return {
          success: true,
          finalSender: sender,
          attempts,
          messageId: result.messageId,
        };
      }

      // Send returned success: false
      const classification = classifyError(result.error, channel);
      registry.recordFailure(sender.config.id, classification.trips_breaker);
      lastResult = result;
      lastCategory = classification.category;

      attempts.push({
        sender_id: sender.config.id,
        attempt: attemptIndex,
        provider: sender.config.provider,
        success: false,
        error: result.error,
        error_category: classification.category,
        duration_ms: durationMs,
      });

      if (!classification.failover || i === limit - 1) {
        // Terminal or out of attempts
        break;
      }
      log.warn(
        {
          sender_id: sender.config.id,
          attempt: attemptIndex,
          error: result.error,
          category: classification.category,
        },
        `Sender '${sender.config.id}' failed with transient error; failing over to next candidate`
      );
    } catch (error) {
      const durationMs = Date.now() - start;
      const errorMsg = error instanceof Error ? error.message : String(error);
      const classification = classifyError(error, channel);
      registry.recordFailure(sender.config.id, classification.trips_breaker);
      lastResult = { success: false, error: errorMsg };
      lastCategory = classification.category;

      attempts.push({
        sender_id: sender.config.id,
        attempt: attemptIndex,
        provider: sender.config.provider,
        success: false,
        error: errorMsg,
        error_category: classification.category,
        duration_ms: durationMs,
      });

      if (!classification.failover || i === limit - 1) {
        break;
      }
      log.warn(
        {
          sender_id: sender.config.id,
          attempt: attemptIndex,
          error: errorMsg,
          category: classification.category,
        },
        `Sender '${sender.config.id}' threw transient exception; failing over to next candidate`
      );
    }
  }

  return {
    success: false,
    finalSender,
    attempts,
    error: lastResult.error,
    error_category: lastCategory,
  };
}
