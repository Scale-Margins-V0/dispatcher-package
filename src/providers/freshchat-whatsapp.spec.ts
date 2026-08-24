import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  formatFreshchatPhone,
  parseFreshchatTemplateSpec,
  resolveFreshchatConfig,
  FreshchatWhatsAppProvider,
  freshchatConfigFromSender,
} from "./freshchat-whatsapp.js";
import type { UserRecord } from "../user-lookup/types.js";
import type { SenderConfig } from "./types.js";

const fetchMock = vi.fn();

describe("freshchat-whatsapp provider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    delete process.env.FRESHCHAT_API_KEY;
    delete process.env.FRESHCHAT_OUTBOUND_MESSAGES_URL;
    delete process.env.FRESHCHAT_NAMESPACE;
    delete process.env.FRESHCHAT_FROM_NUMBER;
    delete process.env.FRESHCHAT_EVENT_TEST_RECIPIENTS;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("formatFreshchatPhone ensures + prefix and strips spaces", () => {
    expect(formatFreshchatPhone("919876543211")).toBe("+919876543211");
    expect(formatFreshchatPhone("+919876543210")).toBe("+919876543210");
    expect(formatFreshchatPhone(" +91 798 437 ")).toBe("+91798437");
  });

  it("resolveFreshchatConfig resolves environment variables", () => {
    process.env.FRESHCHAT_API_KEY = "test-token";
    process.env.FRESHCHAT_OUTBOUND_MESSAGES_URL =
      "https://example.freshchat.com/v2/outbound-messages/whatsapp";
    process.env.FRESHCHAT_NAMESPACE = "test-namespace-123";
    process.env.FRESHCHAT_FROM_NUMBER = "919876543210";

    const cfg = resolveFreshchatConfig();
    expect(cfg).not.toBeNull();
    expect(cfg?.apiKey).toBe("test-token");
    expect(cfg?.fromNumber).toBe("+919876543210");
    expect(cfg?.namespace).toBe("test-namespace-123");
  });

  it("freshchatConfigFromSender extracts sender config cleanly", () => {
    const sender: SenderConfig = {
      id: "fc-sender-1",
      channel: "whatsapp",
      provider: "freshchat",
      from: "+919876543210",
      freshchat: {
        api_key: "custom-key",
        api_endpoint: "https://custom.freshchat.com/v2/outbound-messages/whatsapp",
        namespace: "custom-ns",
        from_number: "+919876543210",
        default_template: "welcome_template",
      },
    };

    const cfg = freshchatConfigFromSender(sender);
    expect(cfg.apiKey).toBe("custom-key");
    expect(cfg.apiEndpoint).toBe("https://custom.freshchat.com/v2/outbound-messages/whatsapp");
    expect(cfg.namespace).toBe("custom-ns");
    expect(cfg.fromNumber).toBe("+919876543210");
    expect(cfg.defaultTemplate).toBe("welcome_template");
  });

  it("parseFreshchatTemplateSpec extracts placeholders in order of appearance", () => {
    const spec = parseFreshchatTemplateSpec({
      template_id: "discount_offer",
      caption: "Hello {{first_name}},\nGet total {{percent}}% off on {{product_name}}",
      media_url: "https://cdn.example/offer.png",
    });

    expect(spec?.template_id).toBe("discount_offer");
    expect(spec?.params).toEqual(["{{first_name}}", "{{percent}}", "{{product_name}}"]);
    expect(spec?.media_url).toBe("https://cdn.example/offer.png");
  });

  it("sends WhatsApp template with media_url and body params via Freshchat API (positional args)", async () => {
    process.env.FRESHCHAT_API_KEY = "test-token";
    process.env.FRESHCHAT_OUTBOUND_MESSAGES_URL =
      "https://example.freshchat.com/v2/outbound-messages/whatsapp";
    process.env.FRESHCHAT_FROM_NUMBER = "+919878908767";
    process.env.FRESHCHAT_NAMESPACE = "124dc328_2252_4914_8472_XXXX";

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 202,
      text: async () =>
        JSON.stringify({
          request_id: "req_123456",
          status: "Request created successfully",
        }),
    });

    const provider = new FreshchatWhatsAppProvider();
    const mockUser: UserRecord = {
      user_id: "user-1",
      email: "user@example.com",
      fields: { first_name: "Vivek", company_name: "Acme" },
    };

    const result = await provider.send(
      "+919876543211",
      {
        template_id: "discount_offer",
        params: ["{{first_name}}", "{{company_name}}"],
        media_url: "https://cdn.example/banner.png",
      },
      mockUser,
      { campaign_id: "camp-1", organization_id: "org-1" }
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("req_123456");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, req] = fetchMock.mock.calls[0];
    expect(url).toContain("/v2/outbound-messages/whatsapp");
    const body = JSON.parse(req.body);
    expect(body.from.phone_number).toBe("+919878908767");
    expect(body.to[0].phone_number).toBe("+919876543211");
    expect(body.data.message_template.template_name).toBe("discount_offer");
    expect(body.data.message_template.rich_template_data.header).toEqual({
      type: "image",
      media_url: "https://cdn.example/banner.png",
      media: { url: "https://cdn.example/banner.png" },
    });
    expect(body.data.message_template.rich_template_data.body.params).toEqual([
      { data: "Vivek" },
      { data: "Acme" },
    ]);
  });

  it("sends WhatsApp template via unified WhatsAppMessage object (sendWithFailover format)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 202,
      text: async () =>
        JSON.stringify({
          request_id: "req_multi_789",
          status: "Request created successfully",
        }),
    });

    const senderConfig: SenderConfig = {
      id: "fc-isolated",
      channel: "whatsapp",
      provider: "freshchat",
      freshchat: {
        api_key: "isolated-token",
        api_endpoint: "https://api.freshchat.com/v2/outbound-messages/whatsapp",
        from_number: "+919999900000",
        namespace: "ns-isolated",
      },
    };

    const provider = new FreshchatWhatsAppProvider(freshchatConfigFromSender(senderConfig));
    const mockUser: UserRecord = {
      user_id: "user-2",
      email: "user2@example.com",
      fields: { first_name: "Priya" },
    };

    const result = await provider.send({
      to: "+919876543212",
      template: {
        template_id: "winter_sale",
        params: ["{{first_name}}"],
      },
      mediaUrl: "https://cdn.example/winter.png",
      user: mockUser,
      personalizeCtx: { campaign_id: "camp-2", organization_id: "org-1" },
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("req_multi_789");

    const [url, req] = fetchMock.mock.calls[0];
    expect(req.headers.Authorization).toBe("Bearer isolated-token");
    const body = JSON.parse(req.body);
    expect(body.from.phone_number).toBe("+919999900000");
    expect(body.to[0].phone_number).toBe("+919876543212");
    expect(body.data.message_template.template_name).toBe("winter_sale");
    expect(body.data.message_template.rich_template_data.body.params).toEqual([
      { data: "Priya" },
    ]);
  });
});
