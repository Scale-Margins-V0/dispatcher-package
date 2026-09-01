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
  header_type?: "image" | "document" | "video" | "text";
  filename?: string;
  has_cta?: boolean;
  cta_value?: string;
  cta_values?: string[];
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
          type: "image" | "document" | "video" | "text";
          media_url?: string;
          filename?: string;
          text?: string;
        };
        body?: {
          params?: Array<{
            data: string;
          }>;
        };
        button?: Array<{
          subType?: string;
          sub_type?: string;
          params?: Array<{
            data: string;
          }>;
        }>;
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
    cta_value?: string;
    cta_values?: string[];
    storage?: string;
    namespace?: string;
    media_url?: string;
    header_type?: "image" | "document" | "video" | "text";
    filename?: string;
  };
  caption?: string;
  mediaUrl?: string;
  mediaMsgType?: string;
  isTemplate?: boolean;
  hasCta?: boolean;
  ctaValue?: string;
  ctaValues?: string[];
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

export function extractFilenameFromUrl(
  url: string,
  fallback = "document.pdf"
): string {
  try {
    const pathname = new URL(url).pathname;
    const base = pathname.split("/").filter(Boolean).pop();
    if (base && base.includes(".")) {
      return decodeURIComponent(base);
    }
  } catch {
    const clean = url.split("?")[0]?.split("#")[0] ?? "";
    const base = clean.split("/").filter(Boolean).pop();
    if (base && base.includes(".")) {
      return base;
    }
  }
  return fallback;
}

export function detectMediaHeaderType(
  mediaUrl: string,
  explicitType?: "image" | "document" | "video" | "text"
): "image" | "document" | "video" | "text" {
  if (explicitType) {
    return explicitType;
  }
  const clean = mediaUrl.split("?")[0]?.split("#")[0]?.toLowerCase() ?? "";
  if (
    clean.endsWith(".pdf") ||
    clean.endsWith(".doc") ||
    clean.endsWith(".docx") ||
    clean.endsWith(".xls") ||
    clean.endsWith(".xlsx") ||
    clean.endsWith(".ppt") ||
    clean.endsWith(".pptx") ||
    clean.endsWith(".txt") ||
    clean.endsWith(".csv")
  ) {
    return "document";
  }
  if (
    clean.endsWith(".mp4") ||
    clean.endsWith(".mov") ||
    clean.endsWith(".3gp") ||
    clean.endsWith(".mkv") ||
    clean.endsWith(".webm") ||
    clean.endsWith(".avi")
  ) {
    return "video";
  }
  return "image";
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

  const headerType = (content?.header_type as "image" | "document" | "video" | "text" | undefined) || undefined;
  const filename =
    typeof content?.filename === "string" && content.filename.trim()
      ? content.filename.trim()
      : undefined;

  const hasCta =
    typeof content?.has_cta === "boolean"
      ? content.has_cta
      : typeof content?.hasCTA === "boolean"
        ? content.hasCTA
        : undefined;

  const ctaValue =
    typeof content?.cta_value === "string" && content.cta_value.trim()
      ? content.cta_value.trim()
      : typeof content?.ctaValue === "string" && content.ctaValue.trim()
        ? content.ctaValue.trim()
        : typeof content?.cta_url === "string" && content.cta_url.trim()
          ? content.cta_url.trim()
          : typeof content?.ctaUrl === "string" && content.ctaUrl.trim()
            ? content.ctaUrl.trim()
            : undefined;

  const ctaValues =
    Array.isArray(content?.cta_values) && content.cta_values.length > 0
      ? content.cta_values.map((u) => String(u).trim()).filter(Boolean)
      : Array.isArray(content?.ctaValues) && content.ctaValues.length > 0
        ? content.ctaValues.map((u) => String(u).trim()).filter(Boolean)
        : Array.isArray(content?.cta_urls) && content.cta_urls.length > 0
          ? content.cta_urls.map((u) => String(u).trim()).filter(Boolean)
          : Array.isArray(content?.ctaUrls) && content.ctaUrls.length > 0
            ? content.ctaUrls.map((u) => String(u).trim()).filter(Boolean)
            : Array.isArray(content?.button_params) && content.button_params.length > 0
              ? content.button_params.map((u) => String(u).trim()).filter(Boolean)
              : undefined;

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
      filename,
      has_cta: hasCta,
      cta_value: ctaValue,
      cta_values: ctaValues,
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
      filename,
      has_cta: hasCta,
      cta_value: ctaValue,
      cta_values: ctaValues,
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
          filename: parsed.filename || filename,
          has_cta: parsed.has_cta ?? parsed.hasCTA ?? hasCta,
          cta_value: parsed.cta_value || parsed.ctaValue || parsed.cta_url || parsed.ctaUrl || ctaValue,
          cta_values: parsed.cta_values || parsed.ctaValues || parsed.cta_urls || parsed.ctaUrls || ctaValues,
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
          filename: parsed.filename || filename,
          has_cta: parsed.has_cta ?? parsed.hasCTA ?? hasCta,
          cta_value: parsed.cta_value || parsed.ctaValue || parsed.cta_url || parsed.ctaUrl || ctaValue,
          cta_values: parsed.cta_values || parsed.ctaValues || parsed.cta_urls || parsed.ctaUrls || ctaValues,
        };
      } catch {}
    }
    return {
      template_id: fallback,
      template_name: fallback,
      media_url: mediaUrl,
      header_type: headerType,
      filename,
      has_cta: hasCta,
      cta_value: ctaValue,
      cta_values: ctaValues,
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
          filename: msg.template.filename,
          has_cta: msg.template.has_cta ?? msg.hasCta,
          cta_value:
            msg.template.cta_value ??
            msg.template.cta_url ??
            msg.ctaValue ??
            msg.ctaUrl,
          cta_values:
            msg.template.cta_values ??
            msg.template.cta_urls ??
            msg.ctaValues ??
            msg.ctaUrls,
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

    // Collect dynamic CTA buttons / values if supplied
    const ctaItems: string[] = [];
    const rawCtaList = templateSpec.cta_values;
    if (Array.isArray(rawCtaList) && rawCtaList.length > 0) {
      for (const u of rawCtaList) {
        if (typeof u === "string" && u.trim()) {
          ctaItems.push(u.trim());
        }
      }
    } else {
      const singleCta = templateSpec.cta_value;
      if (typeof singleCta === "string" && singleCta.trim()) {
        ctaItems.push(singleCta.trim());
      }
    }

    // Attach rich_template_data if media header, body params, or dynamic CTA buttons exist
    if (personalizedParams.length > 0 || mediaUrl || ctaItems.length > 0) {
      messageTemplate.rich_template_data = {};

      if (mediaUrl) {
        const headerType = detectMediaHeaderType(mediaUrl, templateSpec.header_type);
        const headerObj: NonNullable<
          NonNullable<
            FreshchatWhatsAppPayload["data"]["message_template"]["rich_template_data"]
          >["header"]
        > = {
          type: headerType,
          media_url: mediaUrl,
        };

        if (headerType === "document") {
          headerObj.filename =
            templateSpec.filename?.trim() ||
            extractFilenameFromUrl(mediaUrl, "document.pdf");
        }

        messageTemplate.rich_template_data.header = headerObj;
      }

      if (personalizedParams.length > 0) {
        messageTemplate.rich_template_data.body = {
          params: personalizedParams.map((param) => ({ data: String(param) })),
        };
      }

      if (ctaItems.length > 0) {
        const personalizedCtas = ctaItems.map((item) => {
          if (user && personalizeCtx) {
            return personalize(item, user, personalizeCtx, resolvedVars);
          }
          return item;
        });

        messageTemplate.rich_template_data.button = personalizedCtas.map((cta) => ({
          subType: "url",
          params: [{ data: String(cta) }],
        }));
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

      console.log("Freshchat response text:", responseText);

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
