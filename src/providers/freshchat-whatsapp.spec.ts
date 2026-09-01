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

  it("resolveFreshchatConfig resolves environment variables with FRESHCHAT_SOURCE", () => {
    process.env.FRESHCHAT_API_KEY = "test-token";
    process.env.FRESHCHAT_OUTBOUND_MESSAGES_URL =
      "https://example.freshchat.com/v2/outbound-messages/whatsapp";
    process.env.FRESHCHAT_NAMESPACE = "test-namespace-123";
    process.env.FRESHCHAT_SOURCE = "918306107771";
    process.env.FRESHCHAT_TEMPLATE_LANGUAGE = "en";

    const cfg = resolveFreshchatConfig();
    expect(cfg).not.toBeNull();
    expect(cfg?.apiKey).toBe("test-token");
    expect(cfg?.source).toBe("+918306107771");
    expect(cfg?.namespace).toBe("test-namespace-123");
    expect(cfg?.templateLanguage).toBe("en");
  });

  it("freshchatConfigFromSender extracts sender config with source and template_api_url cleanly", () => {
    const sender: SenderConfig = {
      id: "fc-sender-1",
      channel: "whatsapp",
      provider: "freshchat",
      organizations: ["*"],
      freshchat: {
        mode: "api_key",
        api_key: "custom-key",
        template_api_url: "https://custom.freshchat.com/v2/outbound-messages/whatsapp",
        namespace: "custom-ns",
        source: "918306107771",
        default_template: "study_abroad_enquiry",
        template_language: "en",
      },
    };

    const cfg = freshchatConfigFromSender(sender);
    expect(cfg.apiKey).toBe("custom-key");
    expect(cfg.apiEndpoint).toBe("https://custom.freshchat.com/v2/outbound-messages/whatsapp");
    expect(cfg.namespace).toBe("custom-ns");
    expect(cfg.source).toBe("+918306107771");
    expect(cfg.defaultTemplate).toBe("study_abroad_enquiry");
    expect(cfg.templateLanguage).toBe("en");
  });

  it("parseFreshchatTemplateSpec extracts array params and variables cleanly", () => {
    const specWithParams = parseFreshchatTemplateSpec({
      template_name: "study_abroad_v1",
      params: ["{{first_name}}", "Custom City", "SAVE100", "{{age}}"],
      media_url: "https://cdn.example/brochure.pdf",
    });

    expect(specWithParams?.template_name).toBe("study_abroad_v1");
    expect(specWithParams?.template_id).toBe("study_abroad_v1");
    expect(specWithParams?.params).toEqual([
      "{{first_name}}",
      "Custom City",
      "SAVE100",
      "{{age}}",
    ]);
    expect(specWithParams?.media_url).toBe("https://cdn.example/brochure.pdf");

    const specWithVariables = parseFreshchatTemplateSpec({
      template_id: "order_status",
      variables: ["{{order_id}}", "Delivered"],
    });
    expect(specWithVariables?.template_id).toBe("order_status");
    expect(specWithVariables?.params).toEqual(["{{order_id}}", "Delivered"]);
  });

  it("parseFreshchatTemplateSpec falls back to extracting placeholders in order of appearance", () => {
    const spec = parseFreshchatTemplateSpec({
      template_id: "discount_offer",
      caption: "Hello {{first_name}},\nGet total {{percent}}% off on {{product_name}}",
      media_url: "https://cdn.example/offer.png",
    });

    expect(spec?.template_id).toBe("discount_offer");
    expect(spec?.params).toEqual(["{{first_name}}", "{{percent}}", "{{product_name}}"]);
    expect(spec?.media_url).toBe("https://cdn.example/offer.png");
  });

  it("sends Plain Template without rich_template_data (no media, no body params)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 202,
      text: async () =>
        JSON.stringify({
          request_id: "plain_req_101",
          status: "Request created successfully",
        }),
    });

    const senderConfig: SenderConfig = {
      id: "fc-plain",
      channel: "whatsapp",
      provider: "freshchat",
      freshchat: {
        mode: "api_key",
        api_key: "plain-token",
        source: "+919876543210",
        namespace: "plain-ns",
      },
    };

    const provider = new FreshchatWhatsAppProvider(freshchatConfigFromSender(senderConfig));
    const result = await provider.send({
      to: "+919876543211",
      template: {
        template_id: "account_activated_plain",
      },
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("plain_req_101");

    const [url, req] = fetchMock.mock.calls[0];
    const body = JSON.parse(req.body);
    expect(body.from.phone_number).toBe("+919876543210");
    expect(body.to[0].phone_number).toBe("+919876543211");
    expect(body.data.message_template.template_name).toBe("account_activated_plain");
    expect(body.data.message_template.rich_template_data).toBeUndefined();
  });

  it("sends Media Template with document header (PDF) and filename", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 202,
      text: async () =>
        JSON.stringify({
          request_id: "doc_req_202",
          status: "Request created successfully",
        }),
    });

    const senderConfig: SenderConfig = {
      id: "fc-doc",
      channel: "whatsapp",
      provider: "freshchat",
      freshchat: {
        mode: "api_key",
        api_key: "doc-token",
        source: "+919876543210",
        namespace: "doc-ns",
      },
    };

    const provider = new FreshchatWhatsAppProvider(freshchatConfigFromSender(senderConfig));
    const result = await provider.send({
      to: "+919876543211",
      template: {
        template_id: "invoice_doc_template",
        media_url: "https://example.com/invoices/inv_123.pdf",
      },
    });

    expect(result.success).toBe(true);
    const [, req] = fetchMock.mock.calls[0];
    const body = JSON.parse(req.body);
    expect(body.data.message_template.rich_template_data.header).toEqual({
      type: "document",
      media_url: "https://example.com/invoices/inv_123.pdf",
      filename: "inv_123.pdf",
    });
    expect(body.data.message_template.rich_template_data.body).toBeUndefined();
    expect(body.data.message_template.rich_template_data.button).toBeUndefined();
  });

  it("sends Media Template with dynamic single and multiple CTA buttons", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 202,
      text: async () =>
        JSON.stringify({
          request_id: "cta_req_505",
          status: "Request created successfully",
        }),
    });

    const senderConfig: SenderConfig = {
      id: "fc-cta",
      channel: "whatsapp",
      provider: "freshchat",
      freshchat: {
        api_key: "cta-token",
        source: "+919876543210",
        namespace: "cta-ns",
      },
    };

    const provider = new FreshchatWhatsAppProvider(freshchatConfigFromSender(senderConfig));
    const mockUser: UserRecord = {
      user_id: "usr_cta_1",
      email: "usr_cta_1@example.com",
      fields: {
        first_name: "Priya",
        order_id: "ORD-999",
      },
    };

    const result = await provider.send({
      to: "+919876543211",
      freshchatSpec: {
        template_name: "order_confirmation_cta",
        params: ["{{first_name}}"],
        cta_values: [
          "https://example.com/orders/{{order_id}}",
          "https://example.com/support/{{first_name}}",
        ],
      },
      user: mockUser,
      personalizeCtx: { campaign_id: "camp_cta", organization_id: "org_cta" },
    });

    expect(result.success).toBe(true);
    const [, req] = fetchMock.mock.calls[0];
    const body = JSON.parse(req.body);
    expect(body.data.message_template.rich_template_data.button).toEqual([
      {
        subType: "url",
        params: [{ data: "https://example.com/orders/ORD-999" }],
      },
      {
        subType: "url",
        params: [{ data: "https://example.com/support/Priya" }],
      },
    ]);
  });

  it("sends Dynamic with Values template resolving unresolved placeholders and keeping resolved strings", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 202,
      text: async () =>
        JSON.stringify({
          request_id: "dyn_req_303",
          status: "Request created successfully",
        }),
    });

    const senderConfig: SenderConfig = {
      id: "fc-dyn",
      channel: "whatsapp",
      provider: "freshchat",
      freshchat: {
        mode: "api_key",
        api_key: "dyn-token",
        source: "+919876543210",
        namespace: "dyn-ns",
      },
    };

    const provider = new FreshchatWhatsAppProvider(freshchatConfigFromSender(senderConfig));
    const mockUser: UserRecord = {
      user_id: "usr_404",
      email: "usr_404@example.com",
      fields: {
        first_name: "Aarav",
        age: "28",
        company_name: "Acme Tech",
      },
    };

    const result = await provider.send({
      to: "+919876543211",
      freshchatSpec: {
        template_name: "welcome_onboarding",
        params: [
          "{{first_name}}",
          "Welcome to ScaleMargin",
          "CODE2026",
          "{{company_name}}",
          "{{age}}",
          "{{dynamic_score}}",
        ],
      },
      user: mockUser,
      personalizeCtx: { campaign_id: "camp_1", organization_id: "org_1" },
      resolvedVars: { dynamic_score: "99.5" },
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("dyn_req_303");

    const [, req] = fetchMock.mock.calls[0];
    const body = JSON.parse(req.body);
    expect(body.data.message_template.template_name).toBe("welcome_onboarding");
    expect(body.data.message_template.rich_template_data.body.params).toEqual([
      { data: "Aarav" },
      { data: "Welcome to ScaleMargin" },
      { data: "CODE2026" },
      { data: "Acme Tech" },
      { data: "28" },
      { data: "99.5" },
    ]);
  });

  it("sends Combined Media + Dynamic Values Template", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 202,
      text: async () =>
        JSON.stringify({
          request_id: "comb_req_404",
          status: "Request created successfully",
        }),
    });

    const senderConfig: SenderConfig = {
      id: "fc-comb",
      channel: "whatsapp",
      provider: "freshchat",
      freshchat: {
        api_key: "comb-token",
        from_number: "+919876543210",
        namespace: "comb-ns",
      },
    };

    const provider = new FreshchatWhatsAppProvider(freshchatConfigFromSender(senderConfig));
    const mockUser: UserRecord = {
      user_id: "user-5",
      email: "user5@example.com",
      fields: { first_name: "Rohan" },
    };

    const result = await provider.send({
      to: "+919876543215",
      template: {
        template_id: "diwali_promo",
        params: ["{{first_name}}", "50% FLAT"],
        media_url: "https://cdn.example/diwali.png",
      },
      user: mockUser,
      personalizeCtx: { campaign_id: "camp-5", organization_id: "org-1" },
    });

    expect(result.success).toBe(true);
    const [, req] = fetchMock.mock.calls[0];
    const body = JSON.parse(req.body);
    expect(body.data.message_template.template_name).toBe("diwali_promo");
    expect(body.data.message_template.rich_template_data.header).toEqual({
      type: "image",
      media_url: "https://cdn.example/diwali.png",
    });
    expect(body.data.message_template.rich_template_data.body.params).toEqual([
      { data: "Rohan" },
      { data: "50% FLAT" },
    ]);
  });
});
