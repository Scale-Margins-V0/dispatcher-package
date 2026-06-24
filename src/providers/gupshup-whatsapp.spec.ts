import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildEnterpriseTemplateMsg,
  buildWhatsAppMediaMessageForUser,
  buildWhatsAppMessageForUser,
  decodeGupshupEnvCaptionValue,
  encodeGupshupGatewayParam,
  hasGupshupMediaEnvFallback,
  normalizePlainCaption,
  normalizePlainMediaUrl,
  parseWhatsAppMediaSpec,
  parseWhatsAppTemplateSpec,
  personalizeTemplateValues,
  previewGupshupSendRequest,
  resolveDevTestRecipient,
  resolveGupshupConfig,
  sendGupshupWhatsApp,
} from "./gupshup-whatsapp.js";
import type { UserRecord } from "../user-lookup/types.js";

const fetchMock = vi.fn();

describe("gupshup-whatsapp", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GUPSHUP_API_KEY;
    delete process.env.GUPSHUP_USER_ID;
    delete process.env.GUPSHUP_PASSWORD;
    delete process.env.GUPSHUP_MESSAGE_TYPE;
    delete process.env.GUPSHUP_SRC_NAME;
    delete process.env.GUPSHUP_SOURCE;
  });

  it("resolveGupshupConfig prefers API key mode", () => {
    process.env.GUPSHUP_API_KEY = "key-1";
    process.env.GUPSHUP_SRC_NAME = "App";
    process.env.GUPSHUP_SOURCE = "918971741003";
    const cfg = resolveGupshupConfig();
    expect(cfg?.mode).toBe("apikey");
    expect(cfg?.apiKey).toBe("key-1");
  });

  it("resolveGupshupConfig falls back to enterprise credentials", () => {
    process.env.GUPSHUP_USER_ID = "2000210958";
    process.env.GUPSHUP_PASSWORD = "secret";
    process.env.GUPSHUP_MESSAGE_TYPE = "HSM";
    const cfg = resolveGupshupConfig();
    expect(cfg?.mode).toBe("enterprise");
    expect(cfg?.userId).toBe("2000210958");
    expect(cfg?.msgType).toBe("HSM");
  });

  it("parseWhatsAppTemplateSpec parses JSON and plain template id", () => {
    expect(
      parseWhatsAppTemplateSpec({
        text_body: '{"id":"tpl-1","params":["{{first_name}}"]}',
      })
    ).toEqual({ id: "tpl-1", params: ["{{first_name}}"] });
    expect(parseWhatsAppTemplateSpec({ html_body: "approved_tpl" })).toEqual({
      template_id: "approved_tpl",
      params: [],
    });
  });

  it("buildEnterpriseTemplateMsg matches smsgupshup HSM shape", () => {
    const msg = buildEnterpriseTemplateMsg(
      { template_id: "tpl-1", params: ["Ada"] },
      ["Ada"],
      "en"
    );
    expect(JSON.parse(msg)).toEqual({
      isTemplate: true,
      template_id: "tpl-1",
      language: "en",
      attributes: ["Ada"],
    });
  });

  it("sendGupshupWhatsApp posts enterprise SendMessage form", async () => {
    process.env.GUPSHUP_USER_ID = "2000210958";
    process.env.GUPSHUP_PASSWORD = "secret";
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "success | 919815235665 | gid-123",
    });

    const cfg = resolveGupshupConfig()!;
    const result = await sendGupshupWhatsApp(
      {
        to: "+919815235665",
        template: { template_id: "tpl-1", attributes: ["there"] },
        context: {
          campaign_id: "c1",
          user_id: "u1",
          organization_id: "o1",
          analytics_callback_url: "https://cb.example",
        },
      },
      cfg
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("gid-123");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://smsgupshup.com");
    const body = init.body as string;
    expect(body).toContain("method=SendMessage");
    expect(body).toContain("userid=2000210958");
    expect(body).toContain("password=secret");
    expect(body).toContain("msg_type=HSM");
    expect(body).toContain("send_to=919815235665");
    expect(decodeURIComponent(body)).toContain(
      '"template_id":"tpl-1"'
    );
    expect(decodeURIComponent(body)).toContain('"attributes":["there"]');
    expect(decodeURIComponent(body)).toContain('"campaign_id":"c1"');
  });

  it("sendGupshupWhatsApp posts io template API when API key is set", async () => {
    process.env.GUPSHUP_API_KEY = "api-key";
    process.env.GUPSHUP_SRC_NAME = "MyApp";
    process.env.GUPSHUP_SOURCE = "918971741003";
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: "submitted", messageId: "wa-1" }),
    });

    const cfg = resolveGupshupConfig()!;
    const result = await sendGupshupWhatsApp(
      {
        to: "919876543210",
        template: { id: "tpl-io", params: ["Hello"] },
      },
      cfg
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("wa-1");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("api-key");
    expect(init.body).toContain("template=");
    expect(decodeURIComponent(init.body as string)).toContain('"params":["Hello"]');
  });

  it("sendGupshupWhatsApp treats a 2xx non-JSON body as a failure (io)", async () => {
    process.env.GUPSHUP_API_KEY = "api-key";
    process.env.GUPSHUP_SRC_NAME = "MyApp";
    process.env.GUPSHUP_SOURCE = "918971741003";
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "<html><body>Service Unavailable</body></html>",
    });

    const cfg = resolveGupshupConfig()!;
    const result = await sendGupshupWhatsApp(
      { to: "919876543210", template: { id: "tpl-io", params: ["Hello"] } },
      cfg
    );

    expect(result.success).toBe(false);
  });

  it("sendGupshupWhatsApp returns a failure instead of throwing on fetch error", async () => {
    process.env.GUPSHUP_API_KEY = "api-key";
    process.env.GUPSHUP_SRC_NAME = "MyApp";
    process.env.GUPSHUP_SOURCE = "918971741003";
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));

    const cfg = resolveGupshupConfig()!;
    const result = await sendGupshupWhatsApp(
      { to: "919876543210", template: { id: "tpl-io", params: ["Hello"] } },
      cfg
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("ECONNRESET");
  });

  it("resolveDevTestRecipient returns first comma-separated number", () => {
    process.env.GUPSHUP_EVENT_TEST_RECIPIENTS = "919876543210,918812345678";
    expect(resolveDevTestRecipient()).toBe("919876543210");
    delete process.env.GUPSHUP_EVENT_TEST_RECIPIENTS;
    expect(resolveDevTestRecipient()).toBeUndefined();
  });

  it("buildWhatsAppMessageForUser personalizes template params", () => {
    const user: UserRecord = {
      user_id: "u1",
      email: "a@example.com",
      fields: { first_name: "Ada" },
    };
    const message = buildWhatsAppMessageForUser(
      { template_id: "tpl-1", params: ["{{first_name}}"] },
      user,
      "919815235665",
      { campaign_id: "c1", organization_id: "o1" }
    );
    expect(message.template?.params).toEqual(["Ada"]);
    expect(message.template?.attributes).toEqual(["Ada"]);
  });

  it("parseWhatsAppMediaSpec reads caption from content", () => {
    expect(
      parseWhatsAppMediaSpec({
        caption: "Dear {{first_name}}",
        media_url: "https://cdn.example/image.png",
      })
    ).toEqual({
      caption: "Dear {{first_name}}",
      media_url: "https://cdn.example/image.png",
    });
  });

  it("parseWhatsAppMediaSpec reads plain env fallback for GatewayAPI", () => {
    process.env.GUPSHUP_EVENT_TEST_CAPTION = "Dear {{first_name}},\\n\\nHello";
    process.env.GUPSHUP_EVENT_TEST_MEDIA_URL =
      "https://cdn.example/image.png";
    expect(parseWhatsAppMediaSpec(undefined)).toEqual({
      caption: "Dear {{first_name}},\n\nHello",
      media_url: "https://cdn.example/image.png",
    });
    expect(hasGupshupMediaEnvFallback()).toBe(true);
    delete process.env.GUPSHUP_EVENT_TEST_CAPTION;
    delete process.env.GUPSHUP_EVENT_TEST_MEDIA_URL;
    expect(hasGupshupMediaEnvFallback()).toBe(false);
  });

  it("normalizePlainCaption expands \\n and leaves plain text unchanged", () => {
    expect(normalizePlainCaption("Dear {{first_name}}, hello")).toBe(
      "Dear {{first_name}}, hello"
    );
    expect(normalizePlainCaption("Line one\\nLine two")).toBe(
      "Line one\nLine two"
    );
    // A literal "+" is real text, not an encoded space.
    expect(normalizePlainCaption("2+2 = 4")).toBe("2+2 = 4");
    // Genuinely percent-encoded values are still decoded ("+" → space there).
    expect(normalizePlainCaption("Hi%20there+now")).toBe("Hi there now");
    // Double-escaped "\\n" (caption JSON-stringified twice upstream) still
    // collapses to a real LF — must never reach the wire as a literal backslash.
    expect(normalizePlainCaption("Line one\\\\nLine two")).toBe(
      "Line one\nLine two"
    );
    // Real newlines (already-parsed JSON) pass through untouched.
    expect(normalizePlainCaption("Line one\nLine two")).toBe(
      "Line one\nLine two"
    );
    // CRLF is normalized to LF.
    expect(normalizePlainCaption("Line one\r\nLine two")).toBe(
      "Line one\nLine two"
    );
  });

  it("normalizePlainMediaUrl decodes pre-encoded URLs to plain", () => {
    expect(
      normalizePlainMediaUrl("https%3A%2F%2Fcdn.example%2Fimage.png")
    ).toBe("https://cdn.example/image.png");
    expect(normalizePlainMediaUrl("https://cdn.example/image.png")).toBe(
      "https://cdn.example/image.png"
    );
  });

  it("buildWhatsAppMediaMessageForUser personalizes caption", () => {
    const user: UserRecord = {
      user_id: "u1",
      email: "a@example.com",
      fields: { first_name: "Ada" },
    };
    const message = buildWhatsAppMediaMessageForUser(
      {
        caption: "Dear {{first_name}}",
        media_url: "https://cdn.example/image.png",
      },
      user,
      "919815235665",
      { campaign_id: "c1", organization_id: "o1" }
    );
    expect(message.caption).toBe("Dear Ada");
    expect(message.mediaUrl).toBe("https://cdn.example/image.png");
    expect(message.isTemplate).toBe(true);
  });

  it("previewGupshupSendRequest shows media gateway wire body", () => {
    process.env.GUPSHUP_USER_ID = "2000210958";
    process.env.GUPSHUP_PASSWORD = "secret";
    const cfg = resolveGupshupConfig()!;
    const preview = previewGupshupSendRequest(
      {
        to: "919815235665",
        caption: "Dear Ada",
        mediaUrl: "https://cdn.example/image.png",
      },
      cfg
    );
    expect(preview.mode).toBe("media_gateway");
    expect(preview.params.media_url).toBe("https://cdn.example/image.png");
    expect(preview.wireBody).toContain(
      `media_url=${encodeGupshupGatewayParam("https://cdn.example/image.png")}`
    );
  });

  it("parseWhatsAppMediaSpec returns caption-only spec when media_url absent", () => {
    expect(
      parseWhatsAppMediaSpec({ caption: "Dear {{first_name}}" })
    ).toEqual({ caption: "Dear {{first_name}}" });
  });

  it("previewGupshupSendRequest shows text gateway wire body when no media_url", () => {
    process.env.GUPSHUP_USER_ID = "2000210958";
    process.env.GUPSHUP_PASSWORD = "secret";
    const cfg = resolveGupshupConfig()!;
    const preview = previewGupshupSendRequest(
      { to: "919815235665", caption: "Dear Ada" },
      cfg
    );
    expect(preview.mode).toBe("text_gateway");
    expect(preview.params.method).toBe("SENDMESSAGE");
    expect(preview.params.msg_type).toBe("TEXT");
    expect(preview.params.msg).toBe("Dear Ada");
    expect(preview.wireBody).not.toContain("media_url=");
  });

  it("sendGupshupWhatsApp posts text gateway SENDMESSAGE when no media_url", async () => {
    process.env.GUPSHUP_USER_ID = "2000210958";
    process.env.GUPSHUP_PASSWORD = "secret";
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ response: { status: "success", id: "text-1" } }),
    });

    const cfg = resolveGupshupConfig()!;
    const result = await sendGupshupWhatsApp(
      { to: "919815235665", caption: "Dear Ada" },
      cfg
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("text-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = String(init.body);
    // POST — params (incl. credentials) go in the form body, not the URL.
    expect(url).toBe("https://mediaapi.smsgupshup.com/GatewayAPI/rest");
    expect(url).not.toContain("password=");
    expect(body).toContain("method=SENDMESSAGE");
    expect(body).toContain("msg_type=TEXT");
    expect(body).toContain("auth_scheme=plain");
    expect(body).toContain("format=json");
    expect(body).toContain(`msg=${encodeGupshupGatewayParam("Dear Ada")}`);
    expect(body).not.toContain("media_url=");
    expect(body).not.toContain("SENDMEDIAMESSAGE");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );
    expect(init.method).toBe("POST");
  });

  it("sendGupshupWhatsApp posts media gateway SENDMEDIAMESSAGE", async () => {
    process.env.GUPSHUP_USER_ID = "2000210958";
    process.env.GUPSHUP_PASSWORD = "secret";
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ response: { status: "success", id: "media-1" } }),
    });

    const cfg = resolveGupshupConfig()!;
    const result = await sendGupshupWhatsApp(
      {
        to: "919815235665",
        caption: "Dear Ada",
        mediaUrl: "https://cdn.example/image.png",
        isTemplate: true,
      },
      cfg
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("media-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = String(init.body);
    // POST — params (incl. credentials) go in the form body, not the URL.
    expect(url).toBe("https://mediaapi.smsgupshup.com/GatewayAPI/rest");
    expect(url).not.toContain("password=");
    expect(body).toContain("method=SENDMEDIAMESSAGE");
    expect(body).toContain("msg_type=IMAGE");
    expect(body).toContain("auth_scheme=plain");
    // isTemplate is no longer sent (matches the Gupshup GatewayAPI curl format).
    expect(body).not.toContain("isTemplate");
    expect(body).toContain(`caption=${encodeGupshupGatewayParam("Dear Ada")}`);
    expect(body).toContain(
      `media_url=${encodeGupshupGatewayParam("https://cdn.example/image.png")}`
    );
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );
    expect(init.method).toBe("POST");
  });

  it("media gateway body matches the Gupshup curl (order, %20, auth_scheme, escaped extra)", () => {
    process.env.GUPSHUP_USER_ID = "2000210958";
    process.env.GUPSHUP_PASSWORD = "secret";
    const cfg = resolveGupshupConfig()!;
    const preview = previewGupshupSendRequest(
      {
        to: "919815235665",
        caption: "Dear Vivek, \n\nThe Financial Service Ltd.",
        mediaUrl: "https://dev.scalemargins.tech/image.png",
        context: {
          campaign_id: "c1",
          user_id: "001",
          organization_id: "o1",
          analytics_callback_url: "https://cb.example",
        },
      },
      cfg
    );
    expect(preview.mode).toBe("media_gateway");
    expect(preview.httpMethod).toBe("POST");
    expect(preview.headers?.["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );
    // Spaces → "%20", comma → "%2C", newline → "%0A" (curl --data-urlencode).
    expect(preview.wireBody).toContain(
      "caption=Dear%20Vivek%2C%20%0A%0AThe%20Financial"
    );
    expect(preview.wireBody).not.toContain("isTemplate");
    // extra is sent with backslash-escaped quotes, matching the reference curl.
    expect(preview.wireBody).toContain(
      `extra=${encodeGupshupGatewayParam('{\\"campaign_id\\":\\"c1\\",\\"user_id\\":\\"001\\",\\"organization_id\\":\\"o1\\",\\"analytics_callback_url\\":\\"https://cb.example\\"}')}`
    );
    // Field order mirrors the curl: method first, format last.
    expect(preview.wireBody.startsWith("method=SENDMEDIAMESSAGE&userid=")).toBe(
      true
    );
    expect(preview.wireBody.endsWith("&format=json")).toBe(true);
    expect(preview.wireBody.indexOf("auth_scheme=plain")).toBeGreaterThan(0);
  });

  it("encodes apostrophes, emojis and ₹ the way curl --data-urlencode does", () => {
    process.env.GUPSHUP_USER_ID = "2000210958";
    process.env.GUPSHUP_PASSWORD = "secret";
    const cfg = resolveGupshupConfig()!;
    const caption =
      "Dear Vivek,\n\nAs GoldenPi completes 9 years, I'm grateful for the " +
      "community we've built together. More than 16 lakh users have joined " +
      "us and together we've invested over ₹6,000 crore.\n\nWhat's New?\n\n" +
      "🙌 Zero Brokerage Investing\n\n💹 Invest with Higher Limit";
    const preview = previewGupshupSendRequest(
      {
        to: "919815235665",
        caption,
        mediaUrl: "https://dev.scalemargins.tech/image.png",
      },
      cfg
    );
    // Straight apostrophe → %27 (encodeURIComponent alone would leave it as ').
    expect(preview.wireBody).toContain("I%27m%20grateful");
    expect(preview.wireBody).toContain("What%27s%20New%3F");
    // ₹ (U+20B9) and the emojis encode as their UTF-8 byte sequences.
    expect(preview.wireBody).toContain("%E2%82%B9");
    expect(preview.wireBody).toContain("%F0%9F%99%8C"); // 🙌
    expect(preview.wireBody).toContain("%F0%9F%92%B9"); // 💹
    // The whole caption is recoverable.
    const body = new URLSearchParams(preview.wireBody);
    expect(body.get("caption")).toBe(caption);
  });
});
