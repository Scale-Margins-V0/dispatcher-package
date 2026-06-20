/**
 * Gupshup WhatsApp outbound:
 *
 * 1. **Media + caption** (GUPSHUP_USER_ID + GUPSHUP_PASSWORD): POST media gateway
 *    `SENDMEDIAMESSAGE` when dispatch includes `caption` (+ plain `media_url`).
 *    Plain URLs from Atlas/env are URL-encoded at send time.
 * 2. **API key** (GUPSHUP_API_KEY): POST https://api.gupshup.io/wa/api/v1/template/msg
 * 3. **Enterprise HSM** (GUPSHUP_USER_ID + GUPSHUP_PASSWORD): POST https://smsgupshup.com
 *    with method=SendMessage (HSM templates via `msg` JSON).
 */

import { applyGupshupTag } from "../events/outbound/gupshup-tagger.js";
import { personalize, type PersonalizeDispatchContext } from "../personalize.js";
import type { UserRecord } from "../user-lookup/types.js";
import type { SendContext, SendResult } from "./types.js";

export type GupshupAuthMode = "apikey" | "enterprise";

export type WhatsAppTemplateSpec = {
  id?: string;
  template_id?: string;
  language?: string;
  /** io API (`params`) or enterprise (`attributes`) — may contain {{placeholders}}. */
  params?: string[];
  attributes?: string[];
};

export type WhatsAppMediaSpec = {
  caption: string;
  media_url: string;
  msg_type?: string;
  is_template?: boolean;
};

export type GupshupWhatsAppMessage = {
  to: string;
  /** Template path — omit when sending media + caption. */
  template?: WhatsAppTemplateSpec;
  /** Media path — personalized caption + public media URL. */
  caption?: string;
  mediaUrl?: string;
  mediaMsgType?: string;
  isTemplate?: boolean;
  context?: SendContext;
};

export type GupshupConfig = {
  mode: GupshupAuthMode;
  apiKey?: string;
  userId?: string;
  password?: string;
  msgType: string;
  srcName?: string;
  source?: string;
  templateApiUrl: string;
  enterpriseApiUrl: string;
  mediaApiUrl: string;
  mediaMsgType: string;
  templateLanguage: string;
};

export function stripPhonePlus(phone: string): string {
  return phone.trim().replace(/^\+/, "").replace(/\s/g, "");
}

/** First number from GUPSHUP_EVENT_TEST_RECIPIENTS (comma-separated) for dev/staging routing. */
export function resolveDevTestRecipient(): string | undefined {
  const raw = process.env.GUPSHUP_EVENT_TEST_RECIPIENTS?.trim();
  if (!raw) return undefined;
  const first = raw
    .split(",")
    .map((s) => stripPhonePlus(s))
    .find(Boolean);
  return first || undefined;
}

function mediaDefaultsFromEnv() {
  return {
    mediaApiUrl:
      process.env.GUPSHUP_MEDIA_API_URL?.trim() ||
      "https://mediaapi.smsgupshup.com/GatewayAPI/rest",
    mediaMsgType: process.env.GUPSHUP_MEDIA_MSG_TYPE?.trim() || "IMAGE",
  };
}

/**
 * Plain caption from env or dispatch. Expands `\n` in .env; decodes legacy URL-encoded values once.
 */
export function normalizePlainCaption(raw: string): string {
  let caption = raw.trim();
  if (!caption) return caption;
  if (/%[0-9A-Fa-f]{2}/.test(caption) || caption.includes("+")) {
    try {
      caption = decodeURIComponent(caption.replace(/\+/g, " "));
    } catch {
      /* keep trimmed */
    }
  }
  return caption.replace(/\\n/g, "\n");
}

/** @deprecated Use normalizePlainCaption */
export function decodeGupshupEnvCaptionValue(raw: string): string {
  return normalizePlainCaption(raw);
}

/** @deprecated Use normalizePlainCaption / normalizePlainMediaUrl */
export function decodeGupshupEnvMediaValue(raw: string): string {
  return normalizePlainCaption(raw);
}

/**
 * Normalize dispatch/env media URL to plain https?://… before gateway encode.
 * Accepts plain URLs from Atlas; decodes once if a pre-encoded value slips through.
 */
export function normalizePlainMediaUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (!/%[0-9A-Fa-f]{2}/.test(trimmed)) return trimmed;
  try {
    const decoded = decodeURIComponent(trimmed.replace(/\+/g, " "));
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch {
    /* keep trimmed */
  }
  return trimmed;
}

/** encodeURIComponent for Gupshup GatewayAPI query values (media_url, caption, …). */
export function encodeGupshupGatewayParam(value: string): string {
  return encodeURIComponent(value);
}

/** True when env provides caption + media_url for GatewayAPI SENDMEDIAMESSAGE. */
export function hasGupshupMediaEnvFallback(): boolean {
  const caption = process.env.GUPSHUP_EVENT_TEST_CAPTION?.trim();
  const mediaUrl = process.env.GUPSHUP_EVENT_TEST_MEDIA_URL?.trim();
  return Boolean(caption && mediaUrl);
}

export function resolveGupshupConfig(): GupshupConfig | null {
  const apiKey = process.env.GUPSHUP_API_KEY?.trim();
  const userId = process.env.GUPSHUP_USER_ID?.trim();
  const password = process.env.GUPSHUP_PASSWORD?.trim();
  const msgType = process.env.GUPSHUP_MESSAGE_TYPE?.trim() || "HSM";
  const templateLanguage =
    process.env.GUPSHUP_TEMPLATE_LANGUAGE?.trim() || "en";
  const mediaDefaults = mediaDefaultsFromEnv();

  if (apiKey) {
    return {
      mode: "apikey",
      apiKey,
      ...(userId && password ? { userId, password } : {}),
      msgType,
      srcName:
        process.env.GUPSHUP_SRC_NAME?.trim() ||
        process.env.GUPSHUP_EVENT_TEST_SRC_NAME?.trim(),
      source:
        process.env.GUPSHUP_SOURCE?.trim() ||
        process.env.GUPSHUP_EVENT_TEST_SOURCE?.trim(),
      templateApiUrl:
        process.env.GUPSHUP_TEMPLATE_API_URL?.trim() ||
        process.env.GUPSHUP_EVENT_TEST_API_URL?.trim() ||
        "https://api.gupshup.io/wa/api/v1/template/msg",
      enterpriseApiUrl:
        process.env.GUPSHUP_ENTERPRISE_API_URL?.trim() ||
        "https://smsgupshup.com",
      ...mediaDefaults,
      templateLanguage,
    };
  }

  if (userId && password) {
    return {
      mode: "enterprise",
      userId,
      password,
      msgType,
      templateApiUrl:
        process.env.GUPSHUP_TEMPLATE_API_URL?.trim() ||
        "https://api.gupshup.io/wa/api/v1/template/msg",
      enterpriseApiUrl:
        process.env.GUPSHUP_ENTERPRISE_API_URL?.trim() ||
        "https://smsgupshup.com",
      ...mediaDefaults,
      templateLanguage,
    };
  }

  return null;
}

/** Parse template spec from dispatch content or env fallback. */
export function parseWhatsAppTemplateSpec(
  content: { html_body?: string; text_body?: string } | undefined,
  envFallback?: string
): WhatsAppTemplateSpec | null {
  const raw =
    content?.text_body?.trim() ||
    content?.html_body?.trim() ||
    envFallback?.trim() ||
    process.env.GUPSHUP_DEFAULT_TEMPLATE?.trim() ||
    process.env.GUPSHUP_EVENT_TEST_TEMPLATE?.trim();

  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.caption === "string" && obj.caption.trim()) {
        return null;
      }
      return parsed as WhatsAppTemplateSpec;
    }
  } catch {
    /* plain template id string */
  }

  if (raw.length > 0 && !raw.includes("\n")) {
    return { template_id: raw, params: [] };
  }

  return null;
}

type ContentWithMedia = {
  caption?: string;
  media_url?: string;
  html_body?: string;
  text_body?: string;
};

type DispatchImage = {
  url: string;
};

/** Media template send when backend supplies caption (+ media_url). */
export function parseWhatsAppMediaSpec(
  content: ContentWithMedia | undefined,
  images?: DispatchImage[]
): WhatsAppMediaSpec | null {
  let caption = content?.caption?.trim()
    ? normalizePlainCaption(content.caption)
    : undefined;
  let media_url = content?.media_url?.trim()
    ? normalizePlainMediaUrl(content.media_url.trim())
    : undefined;
  let msg_type: string | undefined;
  let is_template: boolean | undefined;

  if (!caption) {
    const raw = content?.text_body?.trim() || content?.html_body?.trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (typeof parsed.caption === "string" && parsed.caption.trim()) {
          caption = normalizePlainCaption(parsed.caption.trim());
          if (typeof parsed.media_url === "string") {
            media_url = normalizePlainMediaUrl(parsed.media_url.trim());
          }
          if (typeof parsed.msg_type === "string") {
            msg_type = parsed.msg_type.trim();
          }
          if (typeof parsed.is_template === "boolean") {
            is_template = parsed.is_template;
          }
          if (typeof parsed.isTemplate === "boolean") {
            is_template = parsed.isTemplate;
          }
        }
      } catch {
        /* not JSON media payload */
      }
    }
  }

  if (!caption) {
    const envCaption = process.env.GUPSHUP_EVENT_TEST_CAPTION?.trim();
    if (envCaption) {
      caption = normalizePlainCaption(envCaption);
      media_url =
        media_url ||
        (process.env.GUPSHUP_EVENT_TEST_MEDIA_URL?.trim()
          ? normalizePlainMediaUrl(process.env.GUPSHUP_EVENT_TEST_MEDIA_URL.trim())
          : undefined) ||
        (images?.[0]?.url?.trim()
          ? normalizePlainMediaUrl(images[0].url.trim())
          : undefined);
    }
  }

  if (!caption) return null;

  media_url =
    media_url ||
    (images?.[0]?.url?.trim()
      ? normalizePlainMediaUrl(images[0].url.trim())
      : undefined) ||
    (process.env.GUPSHUP_EVENT_TEST_MEDIA_URL?.trim()
      ? normalizePlainMediaUrl(process.env.GUPSHUP_EVENT_TEST_MEDIA_URL.trim())
      : undefined);

  if (!media_url) {
    throw new Error(
      "WhatsApp media send requires media_url in content, payload.images[0].url, or GUPSHUP_EVENT_TEST_MEDIA_URL"
    );
  }

  return {
    caption,
    media_url,
    ...(msg_type ? { msg_type } : {}),
    ...(is_template !== undefined ? { is_template } : {}),
  };
}

export function templateParamKeys(spec: WhatsAppTemplateSpec): string[] {
  return spec.params ?? spec.attributes ?? [];
}

export function personalizeTemplateValues(
  values: string[],
  user: UserRecord,
  ctx: PersonalizeDispatchContext
): string[] {
  return values.map((value) => personalize(value, user, ctx));
}

export function resolveTemplateId(spec: WhatsAppTemplateSpec): string {
  const id = spec.template_id ?? spec.id;
  if (!id?.trim()) {
    throw new Error("WhatsApp template missing template_id or id");
  }
  return id.trim();
}

function buildIoTemplateJson(
  spec: WhatsAppTemplateSpec,
  personalizedValues: string[]
): string {
  return JSON.stringify({
    id: resolveTemplateId(spec),
    params: personalizedValues,
  });
}

export function buildEnterpriseTemplateMsg(
  spec: WhatsAppTemplateSpec,
  personalizedValues: string[],
  language: string
): string {
  return JSON.stringify({
    isTemplate: true,
    template_id: resolveTemplateId(spec),
    language: spec.language?.trim() || language,
    attributes: personalizedValues,
  });
}

function parseEnterpriseResponse(text: string, status: number): SendResult {
  const trimmed = text.trim();
  if (
    status >= 200 &&
    status < 300 &&
    trimmed.toLowerCase().startsWith("success")
  ) {
    const parts = trimmed.split("|").map((s) => s.trim());
    return {
      success: true,
      messageId: parts[2] || parts[1] || trimmed,
    };
  }
  return {
    success: false,
    error: trimmed || `Gupshup enterprise HTTP ${status}`,
  };
}

function parseIoResponse(text: string, status: number): SendResult {
  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }

  const okStatus =
    data?.status === "submitted" ||
    data?.status === "success" ||
    (status >= 200 && status < 300 && !data?.message);

  if (okStatus) {
    const messageId =
      (typeof data?.messageId === "string" && data.messageId) ||
      (typeof data?.message_id === "string" && data.message_id) ||
      undefined;
    return { success: true, messageId };
  }

  const errMsg =
    (typeof data?.message === "string" && data.message) ||
    trimmedOrEmpty(text) ||
    `Gupshup template API HTTP ${status}`;

  return { success: false, error: errMsg };
}

function trimmedOrEmpty(text: string): string {
  const t = text.trim();
  return t.length > 0 ? t : "";
}

function parseMediaGatewayResponse(text: string, status: number): SendResult {
  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return parseEnterpriseResponse(text, status);
  }

  const response =
    data?.response && typeof data.response === "object"
      ? (data.response as Record<string, unknown>)
      : data;
  const responseStatus =
    typeof response?.status === "string" ? response.status.toLowerCase() : "";

  if (
    status >= 200 &&
    status < 300 &&
    (responseStatus === "success" || responseStatus === "submitted")
  ) {
    const messageId =
      (typeof response?.id === "string" && response.id) ||
      (typeof data?.id === "string" && data.id) ||
      undefined;
    return { success: true, messageId };
  }

  const errMsg =
    (typeof response?.details === "string" && response.details) ||
    (typeof data?.message === "string" && data.message) ||
    trimmedOrEmpty(text) ||
    `Gupshup media API HTTP ${status}`;

  return { success: false, error: errMsg };
}

function buildMediaGatewayRequest(
  config: GupshupConfig,
  message: GupshupWhatsAppMessage,
  tagJson?: string
): { url: string; params: Record<string, string>; wireQuery: string } {
  const params: Record<string, string> = {
    userid: config.userId!,
    password: config.password!,
    send_to: stripPhonePlus(message.to),
    v: "1.1",
    format: "json",
    msg_type: message.mediaMsgType || config.mediaMsgType,
    method: "SENDMEDIAMESSAGE",
    caption: message.caption!.trim(),
    media_url: message.mediaUrl!.trim(),
    isTemplate: message.isTemplate === false ? "false" : "true",
  };
  if (tagJson) {
    params.extra = tagJson;
  }
  const wireQuery = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeGupshupGatewayParam(value)}`)
    .join("&");
  return {
    url: `${config.mediaApiUrl}?${wireQuery}`,
    params,
    wireQuery,
  };
}

export type GupshupSendRequestPreview = {
  mode: "media_gateway" | "io_template" | "enterprise_hsm";
  httpMethod: "POST";
  url: string;
  headers?: Record<string, string>;
  /** Plain values before wire encoding (password redacted in logs). */
  params: Record<string, string>;
  /** Query string or form body as sent on the wire. */
  wireBody: string;
  message: GupshupWhatsAppMessage;
};

function redactGupshupPreviewParams(
  params: Record<string, string>
): Record<string, string> {
  const out = { ...params };
  if (out.password) out.password = "***";
  return out;
}

export function shouldLogGupshupTestPayload(): boolean {
  const v = process.env.GUPSHUP_EVENT_TEST_LOG_PAYLOAD?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no") return false;
  if (v === "1" || v === "true" || v === "yes") return true;
  return Boolean(process.env.GUPSHUP_EVENT_TEST_RECIPIENTS?.trim());
}

function logGupshupTestPayload(preview: GupshupSendRequestPreview): void {
  console.log(
    "[gupshup-event-test] Outbound request payload:\n" +
      JSON.stringify(
        {
          mode: preview.mode,
          httpMethod: preview.httpMethod,
          url: preview.url,
          headers: preview.headers,
          params: redactGupshupPreviewParams(preview.params),
          wireBody: preview.wireBody,
          message: preview.message,
        },
        null,
        2
      )
  );
}

export function previewGupshupSendRequest(
  message: GupshupWhatsAppMessage,
  config: GupshupConfig
): GupshupSendRequestPreview {
  const tagJson = message.context
    ? applyGupshupTag({}, message.context).tag
    : undefined;

  if (message.caption?.trim() && message.mediaUrl?.trim()) {
    const { url, params, wireQuery } = buildMediaGatewayRequest(
      config,
      message,
      tagJson
    );
    return {
      mode: "media_gateway",
      httpMethod: "POST",
      url,
      params,
      wireBody: wireQuery,
      message,
    };
  }

  if (!message.template) {
    throw new Error("WhatsApp send requires template or caption + mediaUrl");
  }

  const templateJson =
    message.template.params !== undefined ||
    message.template.attributes !== undefined
      ? null
      : buildIoTemplateJson(message.template, []);

  const personalizedValues =
    message.template.params ??
    message.template.attributes ??
    templateParamKeys(message.template);

  const ioTemplate =
    templateJson ??
    buildIoTemplateJson(message.template, personalizedValues);
  const enterpriseMsg = buildEnterpriseTemplateMsg(
    message.template,
    personalizedValues,
    config.templateLanguage
  );

  if (config.mode === "apikey") {
    const params: Record<string, string> = {
      channel: "whatsapp",
      source: stripPhonePlus(config.source!),
      destination: stripPhonePlus(message.to),
      "src.name": config.srcName!,
      template: ioTemplate,
    };
    if (tagJson) params.tag = tagJson;
    const body = new URLSearchParams(params);
    return {
      mode: "io_template",
      httpMethod: "POST",
      url: config.templateApiUrl,
      headers: {
        apikey: config.apiKey!,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      params,
      wireBody: body.toString(),
      message,
    };
  }

  const params: Record<string, string> = {
    method: "SendMessage",
    userid: config.userId!,
    password: config.password!,
    v: "1.1",
    auth_scheme: "plain",
    msg_type: config.msgType,
    send_to: stripPhonePlus(message.to),
    msg: enterpriseMsg,
  };
  if (tagJson) params.extra = tagJson;
  const body = new URLSearchParams(params);
  return {
    mode: "enterprise_hsm",
    httpMethod: "POST",
    url: config.enterpriseApiUrl,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    params,
    wireBody: body.toString(),
    message,
  };
}
async function sendViaMediaGateway(
  config: GupshupConfig,
  message: GupshupWhatsAppMessage,
  tagJson?: string
): Promise<SendResult> {
  if (!config.userId || !config.password) {
    return {
      success: false,
      error:
        "WhatsApp media send requires GUPSHUP_USER_ID and GUPSHUP_PASSWORD",
    };
  }
  if (!message.caption?.trim() || !message.mediaUrl?.trim()) {
    return {
      success: false,
      error: "WhatsApp media send requires caption and mediaUrl",
    };
  }

  const { url } = buildMediaGatewayRequest(config, message, tagJson);
  const res = await fetch(url, { method: "POST" });
  const text = await res.text();
  return parseMediaGatewayResponse(text, res.status);
}

async function sendViaApiKey(
  config: GupshupConfig,
  message: GupshupWhatsAppMessage,
  templateJson: string,
  tagJson?: string
): Promise<SendResult> {
  if (!config.apiKey) {
    return { success: false, error: "GUPSHUP_API_KEY is not configured" };
  }
  if (!config.srcName?.trim()) {
    return {
      success: false,
      error:
        "GUPSHUP_SRC_NAME (or GUPSHUP_EVENT_TEST_SRC_NAME) is required with GUPSHUP_API_KEY",
    };
  }
  if (!config.source?.trim()) {
    return {
      success: false,
      error:
        "GUPSHUP_SOURCE (or GUPSHUP_EVENT_TEST_SOURCE) WABA number is required with GUPSHUP_API_KEY",
    };
  }

  const body = new URLSearchParams();
  body.set("channel", "whatsapp");
  body.set("source", stripPhonePlus(config.source));
  body.set("destination", stripPhonePlus(message.to));
  body.set("src.name", config.srcName);
  body.set("template", templateJson);
  if (tagJson) {
    body.set("tag", tagJson);
  }

  const res = await fetch(config.templateApiUrl, {
    method: "POST",
    headers: {
      apikey: config.apiKey,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const text = await res.text();
  return parseIoResponse(text, res.status);
}

async function sendViaEnterprise(
  config: GupshupConfig,
  message: GupshupWhatsAppMessage,
  msgJson: string,
  tagJson?: string
): Promise<SendResult> {
  if (!config.userId || !config.password) {
    return {
      success: false,
      error: "GUPSHUP_USER_ID and GUPSHUP_PASSWORD are required",
    };
  }

  const body = new URLSearchParams();
  body.set("method", "SendMessage");
  body.set("userid", config.userId);
  body.set("password", config.password);
  body.set("v", "1.1");
  body.set("auth_scheme", "plain");
  body.set("msg_type", config.msgType);
  body.set("send_to", stripPhonePlus(message.to));
  body.set("msg", msgJson);
  if (tagJson) {
    body.set("extra", tagJson);
  }

  const res = await fetch(config.enterpriseApiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  return parseEnterpriseResponse(text, res.status);
}

export async function sendGupshupWhatsApp(
  message: GupshupWhatsAppMessage,
  config: GupshupConfig = resolveGupshupConfig()!
): Promise<SendResult> {
  if (shouldLogGupshupTestPayload()) {
    try {
      logGupshupTestPayload(previewGupshupSendRequest(message, config));
    } catch (error) {
      console.warn(
        "[gupshup-event-test] Could not preview outbound payload:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const tagJson = message.context
    ? applyGupshupTag({}, message.context).tag
    : undefined;

  if (message.caption?.trim() && message.mediaUrl?.trim()) {
    return sendViaMediaGateway(config, message, tagJson);
  }

  if (!message.template) {
    return {
      success: false,
      error: "WhatsApp send requires template or caption + mediaUrl",
    };
  }

  const templateJson =
    message.template.params !== undefined ||
    message.template.attributes !== undefined
      ? null
      : buildIoTemplateJson(message.template, []);

  const personalizedValues =
    message.template.params ??
    message.template.attributes ??
    templateParamKeys(message.template);

  const ioTemplate =
    templateJson ??
    buildIoTemplateJson(message.template, personalizedValues);
  const enterpriseMsg = buildEnterpriseTemplateMsg(
    message.template,
    personalizedValues,
    config.templateLanguage
  );

  if (config.mode === "apikey") {
    return sendViaApiKey(config, message, ioTemplate, tagJson);
  }
  return sendViaEnterprise(config, message, enterpriseMsg, tagJson);
}

export class GupshupWhatsAppProvider {
  name = "gupshup-whatsapp";

  private config: GupshupConfig;

  constructor(config?: GupshupConfig | null) {
    const resolved = config ?? resolveGupshupConfig();
    if (!resolved) {
      throw new Error(
        "Gupshup WhatsApp credentials missing — set GUPSHUP_API_KEY or GUPSHUP_USER_ID + GUPSHUP_PASSWORD"
      );
    }
    this.config = resolved;
  }

  async send(message: GupshupWhatsAppMessage): Promise<SendResult> {
    return sendGupshupWhatsApp(message, this.config);
  }
}

export function resolveRecipientPhone(
  user: UserRecord,
  devRecipient?: string
): string | null {
  const raw =
    devRecipient?.trim() ||
    user.fields.phone?.trim() ||
    user.fields.phone_no?.trim();
  if (!raw) return null;
  return stripPhonePlus(raw);
}

export function buildWhatsAppMediaMessageForUser(
  spec: WhatsAppMediaSpec,
  user: UserRecord,
  to: string,
  ctx: PersonalizeDispatchContext,
  sendContext?: SendContext
): GupshupWhatsAppMessage {
  return {
    to,
    caption: personalize(spec.caption, user, ctx),
    mediaUrl: spec.media_url,
    mediaMsgType: spec.msg_type,
    isTemplate: spec.is_template ?? true,
    ...(sendContext ? { context: sendContext } : {}),
  };
}

export function buildWhatsAppMessageForUser(
  spec: WhatsAppTemplateSpec,
  user: UserRecord,
  to: string,
  ctx: PersonalizeDispatchContext,
  sendContext?: SendContext
): GupshupWhatsAppMessage {
  const rawParams = templateParamKeys(spec);
  const personalized = personalizeTemplateValues(rawParams, user, ctx);
  return {
    to,
    template: {
      ...spec,
      params: personalized,
      attributes: personalized,
    },
    ...(sendContext ? { context: sendContext } : {}),
  };
}
