/**
 * Freshchat WhatsApp outbound provider:
 *
 * Calls the Freshchat Outbound Messages API to send templated WhatsApp messages
 * with rich media, headers (image/document/video), and personalized body parameters.
 *
 * Endpoint: POST https://<account>.freshchat.com/v2/outbound-messages/whatsapp
 * Auth: Authorization: Bearer <token>
 */

import { LogComponent } from "../logging/conventions.js";
import { componentLogger } from "../logging/logger.js";
import { personalize, type PersonalizeDispatchContext } from "../personalize.js";
import type { UserRecord } from "../user-lookup/types.js";
import type { SendContext, SendResult, SenderConfig } from "./types.js";

const log = componentLogger(LogComponent.providersFreshchat);

export interface FreshchatConfig {
  apiKey: string;
  apiEndpoint: string;
  source: string;
  namespace?: string;
  defaultTemplate?: string;
  templateLanguage?: string;
}

export interface FreshchatTemplateSpec {
  template_id?: string;
  template_name?: string;
  language?: string;
  storage?: string;
  namespace?: string;
  params?: string[];
  media_url?: string;
  header_type?: "image" | "document" | "video";
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
          type: "image" | "document" | "video";
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
    header_type?: "image" | "document" | "video";
  };
  caption?: string;
  mediaUrl?: string;
  mediaMsgType?: string;
  isTemplate?: boolean;
  hasCta?: boolean;
  context?: SendContext;
  user?: UserRecord;
  personalizeCtx?: PersonalizeDispatchContext;
  resolvedVars?: Record<string, string>;
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
    process.env.FRESHCHAT_TEMPLATE_API_URL?.trim() ||
    process.env.FRESHCHAT_OUTBOUND_MESSAGES_URL?.trim() ||
    "https://api.freshchat.com/v2/outbound-messages/whatsapp";
  const sourceRaw =
    process.env.FRESHCHAT_SOURCE?.trim() ||
    process.env.FRESHCHAT_FROM_NUMBER?.trim();
  const namespace = process.env.FRESHCHAT_NAMESPACE?.trim();
  const defaultTemplate = process.env.FRESHCHAT_DEFAULT_TEMPLATE?.trim();
  const templateLanguage =
    process.env.FRESHCHAT_TEMPLATE_LANGUAGE?.trim() || "en";

  if (!apiKey || !sourceRaw) {
    return null;
  }

  return {
    apiKey,
    apiEndpoint,
    source: formatFreshchatPhone(sourceRaw),
    namespace,
    defaultTemplate,
    templateLanguage,
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
    fc?.template_api_url?.trim() ||
    fc?.api_endpoint?.trim() ||
    (fc?.api_endpoint_env ? process.env[fc.api_endpoint_env]?.trim() : undefined) ||
    process.env.FRESHCHAT_TEMPLATE_API_URL?.trim() ||
    process.env.FRESHCHAT_OUTBOUND_MESSAGES_URL?.trim() ||
    "https://api.freshchat.com/v2/outbound-messages/whatsapp";

  const rawSource = fc?.source !== undefined ? String(fc.source) : undefined;
  const sourceEnv = fc?.source_env ? process.env[fc.source_env]?.trim() : undefined;
  const fromNumberEnv = fc?.from_number_env ? process.env[fc.from_number_env]?.trim() : undefined;

  const sourceRaw =
    rawSource?.trim() ||
    sourceEnv ||
    fc?.from_number?.trim() ||
    fromNumberEnv ||
    sender.from?.trim() ||
    process.env.FRESHCHAT_SOURCE?.trim() ||
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

  const templateLanguage =
    fc?.template_language?.trim() ||
    process.env.FRESHCHAT_TEMPLATE_LANGUAGE?.trim() ||
    "en";

  return {
    apiKey,
    apiEndpoint,
    source: sourceRaw ? formatFreshchatPhone(sourceRaw) : "",
    namespace,
    defaultTemplate,
    templateLanguage,
  };
}

export function parseFreshchatTemplateSpec(
  content: Record<string, unknown> | undefined,
  images?: Array<{ url: string }>,
  senderDefaultTemplate?: string
): FreshchatTemplateSpec | null {
  if (!content && !senderDefaultTemplate) return null;

  const templateId =
    (content && typeof content.template_id === "string" && content.template_id.trim()) ||
    (content && typeof content.template_name === "string" && content.template_name.trim()) ||
    undefined;

  const mediaUrl =
    (content && typeof content.media_url === "string" && content.media_url.trim() ? content.media_url.trim() : undefined) ||
    images?.[0]?.url;

  const headerType = (content?.header_type as "image" | "document" | "video" | undefined) || undefined;

  // 1. Direct array of params or variables from Atlas payload
  const arrayParams =
    (content && Array.isArray(content.params) ? content.params : undefined) ||
    (content && Array.isArray(content.variables) ? content.variables : undefined);

  if (arrayParams) {
    const stringParams = arrayParams.map((p) => String(p));
    return {
      template_id: templateId || senderDefaultTemplate,
      template_name: templateId || senderDefaultTemplate,
      params: stringParams,
      media_url: mediaUrl,
      header_type: headerType,
    };
  }

  // 2. Direct template_id string with caption / text_body extraction
  if (templateId) {
    const caption = typeof content?.caption === "string" ? content.caption : undefined;
    const bodyText = typeof content?.text_body === "string" ? content.text_body : undefined;
    const sourceText = caption || bodyText || "";
    const placeholders = Array.from(sourceText.matchAll(/\{\{([^}]+)\}\}/g)).map(
      (m) => `{{${m[1]?.trim()}}}`
    );

    return {
      template_id: templateId,
      template_name: templateId,
      params: placeholders.length > 0 ? placeholders : undefined,
      media_url: mediaUrl,
      header_type: headerType,
    };
  }

  // 3. Embedded JSON in text_body / html_body
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
          params: Array.isArray(parsed.params)
            ? parsed.params.map((p: unknown) => String(p))
            : Array.isArray(parsed.variables)
            ? parsed.variables.map((p: unknown) => String(p))
            : undefined,
          media_url: parsed.media_url || mediaUrl,
          header_type: parsed.header_type || headerType,
        };
      }
    } catch {
      /* not valid JSON */
    }
  }

  // 4. Fallback to sender or env default template
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
          params: Array.isArray(parsed.params)
            ? parsed.params.map((p: unknown) => String(p))
            : Array.isArray(parsed.variables)
            ? parsed.variables.map((p: unknown) => String(p))
            : undefined,
          media_url: parsed.media_url || mediaUrl,
          header_type: parsed.header_type || headerType,
        };
      } catch {}
    }
    return {
      template_id: fallback,
      template_name: fallback,
      media_url: mediaUrl,
      header_type: headerType,
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
        source: "",
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
    let resolvedVars: Record<string, string> | undefined;
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
      resolvedVars = msg.resolvedVars;
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
          header_type: msg.template.header_type,
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
    const languageCode =
      templateSpec.language ||
      this.config.templateLanguage ||
      "en";
    const storage = templateSpec.storage || "none";

    const rawParams = templateSpec.params || [];
    const personalizedParams = rawParams.map((p) => {
      const paramStr = String(p);
      if (user && personalizeCtx) {
        return personalize(paramStr, user, personalizeCtx, resolvedVars);
      }
      return paramStr;
    });

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

    // Attach rich_template_data only if media header or body params exist
    if (personalizedParams.length > 0 || mediaUrl) {
      messageTemplate.rich_template_data = {};

      if (mediaUrl) {
        let headerType: "image" | "document" | "video" = "image";
        if (templateSpec.header_type) {
          headerType = templateSpec.header_type;
        } else {
          const lower = mediaUrl.toLowerCase();
          if (lower.endsWith(".pdf") || lower.endsWith(".doc") || lower.endsWith(".docx")) {
            headerType = "document";
          } else if (lower.endsWith(".mp4") || lower.endsWith(".mov") || lower.endsWith(".3gp")) {
            headerType = "video";
          }
        }

        messageTemplate.rich_template_data.header = {
          type: headerType,
          media_url: mediaUrl,
          media: {
            url: mediaUrl,
          },
        };
      }

      if (personalizedParams.length > 0) {
        messageTemplate.rich_template_data.body = {
          params: personalizedParams.map((param) => ({ data: String(param) })),
        };
      }
    }

    const payload: FreshchatWhatsAppPayload = {
      from: {
        phone_number: formatFreshchatPhone(this.config.source),
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

        log.info(
          { http_status: response.status, message_id: requestId },
          "Freshchat API returned 2xx status"
        );

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
