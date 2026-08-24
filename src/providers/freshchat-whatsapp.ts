/**
 * Freshchat WhatsApp outbound provider:
 *
 * Calls the Freshchat Outbound Messages API to send templated WhatsApp messages
 * with rich media and personalized body parameters.
 *
 * Endpoint: POST https://<account>.freshchat.com/v2/outbound-messages/whatsapp
 * Auth: Authorization: Bearer <token>
 */

import { componentLogger } from "../logging/logger.js";
import { personalize, type PersonalizeDispatchContext } from "../personalize.js";
import type { UserRecord } from "../user-lookup/types.js";
import type { SendContext, SendResult, SenderConfig } from "./types.js";

const log = componentLogger("providers.freshchat");

export interface FreshchatConfig {
  apiKey: string;
  apiEndpoint: string;
  fromNumber: string;
  namespace?: string;
  defaultTemplate?: string;
}

export interface FreshchatTemplateSpec {
  template_id?: string;
  template_name?: string;
  language?: string;
  storage?: string;
  namespace?: string;
  params?: string[];
  media_url?: string;
}

export interface FreshchatWhatsAppPayload {
  from: {
    phone_number: string;
  };
  to: Array<{
    phone_number: string;
  }>;
  provider: "whatsapp";
  data: {
    message_template: {
      storage: string;
      namespace: string;
      template_name: string;
      language: {
        policy: string;
        code: string;
      };
      rich_template_data?: {
        header?: {
          type: "image";
          media_url?: string;
          media?: {
            url?: string;
          };
        };
        body?: {
          params?: Array<{
            data: string;
          }>;
        };
      };
    };
  };
}

export interface FreshchatSendParams {
  to: string;
  template?: {
    id?: string;
    template_id?: string;
    template_name?: string;
    language?: string;
    params?: string[];
    attributes?: string[];
    has_cta?: boolean;
    storage?: string;
    namespace?: string;
    media_url?: string;
  };
  caption?: string;
  mediaUrl?: string;
  mediaMsgType?: string;
  isTemplate?: boolean;
  hasCta?: boolean;
  context?: SendContext;
  user?: UserRecord;
  personalizeCtx?: PersonalizeDispatchContext;
  freshchatSpec?: FreshchatTemplateSpec;
}

export function formatFreshchatPhone(phone: string): string {
  const cleaned = phone.trim().replace(/\s+/g, "");
  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}

export function resolveFreshchatDevTestRecipient(): string | undefined {
  const raw =
    process.env.FRESHCHAT_EVENT_TEST_RECIPIENTS?.trim() ||
    process.env.FRESHCHAT_DEV_RECIPIENT?.trim();
  if (!raw) return undefined;
  const first = raw
    .split(",")
    .map((s) => s.trim())
    .find(Boolean);
  return first ? formatFreshchatPhone(first) : undefined;
}

export function resolveFreshchatConfig(): FreshchatConfig | null {
  const apiKey = process.env.FRESHCHAT_API_KEY?.trim();
  const apiEndpoint =
    process.env.FRESHCHAT_OUTBOUND_MESSAGES_URL?.trim() ||
    "https://api.freshchat.com/v2/outbound-messages/whatsapp";
  const fromNumberRaw = process.env.FRESHCHAT_FROM_NUMBER?.trim();
  const namespace = process.env.FRESHCHAT_NAMESPACE?.trim();
  const defaultTemplate = process.env.FRESHCHAT_DEFAULT_TEMPLATE?.trim();

  if (!apiKey || !fromNumberRaw) {
    return null;
  }

  return {
    apiKey,
    apiEndpoint,
    fromNumber: formatFreshchatPhone(fromNumberRaw),
    namespace,
    defaultTemplate,
  };
}

export function freshchatConfigFromSender(sender: SenderConfig): FreshchatConfig {
  const fc = sender.freshchat;
  const apiKey =
    fc?.api_key?.trim() ||
    (fc?.api_key_env ? process.env[fc.api_key_env]?.trim() : undefined) ||
    process.env.FRESHCHAT_API_KEY?.trim() ||
    "";

  const apiEndpoint =
    fc?.api_endpoint?.trim() ||
    (fc?.api_endpoint_env ? process.env[fc.api_endpoint_env]?.trim() : undefined) ||
    process.env.FRESHCHAT_OUTBOUND_MESSAGES_URL?.trim() ||
    "https://api.freshchat.com/v2/outbound-messages/whatsapp";

  const fromNumberRaw =
    fc?.from_number?.trim() ||
    (fc?.from_number_env ? process.env[fc.from_number_env]?.trim() : undefined) ||
    sender.from?.trim() ||
    process.env.FRESHCHAT_FROM_NUMBER?.trim() ||
    "";

  const namespace =
    fc?.namespace?.trim() ||
    (fc?.namespace_env ? process.env[fc.namespace_env]?.trim() : undefined) ||
    process.env.FRESHCHAT_NAMESPACE?.trim() ||
    "";

  const defaultTemplate =
    fc?.default_template?.trim() ||
    process.env.FRESHCHAT_DEFAULT_TEMPLATE?.trim();

  return {
    apiKey,
    apiEndpoint,
    fromNumber: fromNumberRaw ? formatFreshchatPhone(fromNumberRaw) : "",
    namespace,
    defaultTemplate,
  };
}

export function parseFreshchatTemplateSpec(
  content: Record<string, unknown> | undefined,
  images?: Array<{ url: string }>,
  senderDefaultTemplate?: string
): FreshchatTemplateSpec | null {
  if (!content && !senderDefaultTemplate) return null;

  // 1. Direct template_id string
  if (content && typeof content.template_id === "string" && content.template_id.trim()) {
    const templateId = content.template_id.trim();
    const mediaUrl =
      typeof content.media_url === "string" && content.media_url.trim()
        ? content.media_url.trim()
        : images?.[0]?.url;

    // Check if caption has {{variables}}
    const caption = typeof content.caption === "string" ? content.caption : undefined;
    const bodyText = typeof content.text_body === "string" ? content.text_body : undefined;
    const sourceText = caption || bodyText || "";
    const placeholders = Array.from(sourceText.matchAll(/\{\{([^}]+)\}\}/g)).map(
      (m) => `{{${m[1]?.trim()}}}`
    );

    return {
      template_id: templateId,
      template_name: templateId,
      params: placeholders.length > 0 ? placeholders : undefined,
      media_url: mediaUrl,
    };
  }

  // 2. Embedded JSON in text_body / html_body
  const rawJson =
    (content && typeof content.text_body === "string" && content.text_body.trim().startsWith("{")
      ? content.text_body.trim()
      : undefined) ||
    (content && typeof content.html_body === "string" && content.html_body.trim().startsWith("{")
      ? content.html_body.trim()
      : undefined);

  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed.template_name || parsed.template_id) {
        return {
          template_id: parsed.template_id || parsed.template_name,
          template_name: parsed.template_name || parsed.template_id,
          language: parsed.language || "en",
          namespace: parsed.namespace,
          storage: parsed.storage || "none",
          params: Array.isArray(parsed.params) ? parsed.params : undefined,
          media_url: parsed.media_url || images?.[0]?.url,
        };
      }
    } catch {
      /* not valid JSON */
    }
  }

  // 3. Fallback to sender or env default template
  const fallback =
    senderDefaultTemplate ||
    process.env.FRESHCHAT_DEFAULT_TEMPLATE?.trim() ||
    process.env.FRESHCHAT_EVENT_TEST_TEMPLATE?.trim();

  if (fallback) {
    if (fallback.startsWith("{")) {
      try {
        const parsed = JSON.parse(fallback);
        return {
          template_id: parsed.template_id || parsed.template_name,
          template_name: parsed.template_name || parsed.template_id,
          language: parsed.language || "en",
          namespace: parsed.namespace,
          storage: parsed.storage || "none",
          params: Array.isArray(parsed.params) ? parsed.params : undefined,
          media_url: parsed.media_url || images?.[0]?.url,
        };
      } catch {}
    }
    return {
      template_id: fallback,
      template_name: fallback,
      media_url: images?.[0]?.url,
    };
  }

  return null;
}

export class FreshchatWhatsAppProvider {
  public readonly name = "freshchat";
  private config: FreshchatConfig;

  constructor(config?: FreshchatConfig) {
    if (config) {
      this.config = config;
    } else {
      const resolved = resolveFreshchatConfig();
      this.config = resolved || {
        apiKey: "",
        apiEndpoint: "https://api.freshchat.com/v2/outbound-messages/whatsapp",
        fromNumber: "",
      };
    }
  }

  /**
   * Unified send method: accepts either a WhatsApp message object (for sendWithFailover)
   * or positional arguments (for legacy callers / direct unit tests).
   */
  async send(
    messageOrPhone: FreshchatSendParams | string,
    legacySpec?: FreshchatTemplateSpec,
    legacyUser?: UserRecord,
    legacyCtx?: PersonalizeDispatchContext
  ): Promise<SendResult> {
    let toPhone: string;
    let templateSpec: FreshchatTemplateSpec | null = null;
    let user: UserRecord | undefined;
    let personalizeCtx: PersonalizeDispatchContext | undefined;
    let explicitMediaUrl: string | undefined;

    if (typeof messageOrPhone === "string") {
      toPhone = messageOrPhone;
      templateSpec = legacySpec ?? null;
      user = legacyUser;
      personalizeCtx = legacyCtx;
    } else {
      const msg = messageOrPhone;
      toPhone = msg.to;
      user = msg.user;
      personalizeCtx = msg.personalizeCtx;
      explicitMediaUrl = msg.mediaUrl;

      if (msg.freshchatSpec) {
        templateSpec = msg.freshchatSpec;
      } else if (msg.template) {
        templateSpec = {
          template_id: msg.template.template_id || msg.template.id,
          template_name: msg.template.template_id || msg.template.id,
          language: msg.template.language,
          storage: msg.template.storage,
          namespace: msg.template.namespace,
          params: msg.template.params || msg.template.attributes,
          media_url: msg.template.media_url || explicitMediaUrl,
        };
      }
    }

    if (!templateSpec) {
      return {
        success: false,
        error: "Missing WhatsApp template specification for Freshchat send",
      };
    }

    const templateName =
      templateSpec.template_name ||
      templateSpec.template_id ||
      this.config.defaultTemplate;

    if (!templateName) {
      return {
        success: false,
        error: "Missing template_name or template_id for Freshchat WhatsApp send",
      };
    }

    const namespace = templateSpec.namespace || this.config.namespace || "";
    const languageCode = templateSpec.language || "en";
    const storage = templateSpec.storage || "none";

    const rawParams = templateSpec.params || [];
    const personalizedParams = rawParams.map((p) =>
      user && personalizeCtx ? personalize(p, user, personalizeCtx) : p
    );

    const messageTemplate: FreshchatWhatsAppPayload["data"]["message_template"] = {
      storage,
      namespace,
      template_name: templateName,
      language: {
        policy: "deterministic",
        code: languageCode,
      },
    };

    const mediaUrl = explicitMediaUrl || templateSpec.media_url;
    if (personalizedParams.length > 0 || mediaUrl) {
      messageTemplate.rich_template_data = {};

      if (mediaUrl) {
        messageTemplate.rich_template_data.header = {
          type: "image",
          media_url: mediaUrl,
          media: {
            url: mediaUrl,
          },
        };
      }

      if (personalizedParams.length > 0) {
        messageTemplate.rich_template_data.body = {
          params: personalizedParams.map((param) => ({ data: param })),
        };
      }
    }

    const payload: FreshchatWhatsAppPayload = {
      from: {
        phone_number: this.config.fromNumber,
      },
      to: [
        {
          phone_number: formatFreshchatPhone(toPhone),
        },
      ],
      provider: "whatsapp",
      data: {
        message_template: messageTemplate,
      },
    };

    try {
      const response = await fetch(this.config.apiEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      const responseText = await response.text();
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(responseText);
      } catch {
        /* non-JSON response */
      }

      if (response.ok) {
        const requestId =
          (typeof data.request_id === "string" && data.request_id) ||
          (typeof data.id === "string" && data.id) ||
          undefined;

        return {
          success: true,
          messageId: requestId,
        };
      }

      const errMsg =
        (typeof data.status === "string" && data.status) ||
        (typeof data.message === "string" && data.message) ||
        responseText ||
        `Freshchat API HTTP ${response.status}`;

      log.warn(
        { http_status: response.status, error_message: errMsg },
        "Freshchat API returned non-2xx status"
      );

      return {
        success: false,
        error: errMsg,
      };
    } catch (error) {
      const errMsg =
        error instanceof Error ? error.message : "Freshchat WhatsApp send failed";
      log.error({ err: error }, "Freshchat network error");
      return {
        success: false,
        error: errMsg,
      };
    }
  }
}
