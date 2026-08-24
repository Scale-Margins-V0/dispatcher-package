import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveSenderPin, resolveSenderChainForRecipient, registry } from "./senders.js";
import { resetEnvYamlForTests, setEnvYamlForTests } from "../env-yaml.js";
import { scrubPii } from "../events/scrubber.js";
import { getAllSendGridPublicKeys, getAllGupshupWebhookSecrets } from "../events/index.js";
import type { DispatchPayload } from "../dispatch/types.js";

describe("Multi-Sender Dispatcher Feature Suite", () => {
  beforeEach(() => {
    resetEnvYamlForTests();
    registry.resetForTests();
    process.env.SENDGRID_API_KEY = "SG.test-dummy-key";
  });

  afterEach(() => {
    resetEnvYamlForTests();
    registry.resetForTests();
    delete process.env.SENDGRID_API_KEY;
  });

  describe("resolveSenderPin", () => {
    it("accepts unpinned payloads when senders are available", () => {
      setEnvYamlForTests({
        version: 1,
        senders: [
          {
            id: "ses-primary",
            channel: "email",
            provider: "ses",
            weight: 1,
            enabled: true,
            organizations: ["*"],
          },
        ],
      });

      const payload: DispatchPayload = {
        campaign_id: "c-1",
        channel: "email",
        user_ids: ["u-1"],
        content: { subject: "Hi", html_body: "<p>Hello</p>" },
        metadata: {
          organization_id: "org-1",
          analytics_callback_url: "https://example.com/cb",
        },
      };

      const result = resolveSenderPin(payload);
      expect(result.ok).toBe(true);
    });

    it("rejects pinned sender_id that does not exist in .env.yaml", () => {
      setEnvYamlForTests({
        version: 1,
        senders: [
          {
            id: "ses-primary",
            channel: "email",
            provider: "ses",
            weight: 1,
            enabled: true,
          },
        ],
      });

      const payload: DispatchPayload = {
        campaign_id: "c-1",
        channel: "email",
        user_ids: ["u-1"],
        content: { subject: "Hi" },
        metadata: {
          sender_id: "nonexistent-sender",
          organization_id: "org-1",
          analytics_callback_url: "https://example.com/cb",
        },
      };

      const result = resolveSenderPin(payload);
      expect(result.ok).toBe(false);
      if (!result.ok && result.error) {
        expect(result.error.code).toBe("unknown_sender_id");
        expect(result.error.message).toContain("nonexistent-sender");
      }
    });

    it("rejects pinned sender_id when organization is not authorized", () => {
      setEnvYamlForTests({
        version: 1,
        senders: [
          {
            id: "ses-corp",
            channel: "email",
            provider: "ses",
            organizations: ["org-corp"],
            weight: 1,
            enabled: true,
          },
        ],
      });

      const payload: DispatchPayload = {
        campaign_id: "c-1",
        channel: "email",
        user_ids: ["u-1"],
        content: { subject: "Hi" },
        metadata: {
          sender_id: "ses-corp",
          organization_id: "org-unauthorized",
          analytics_callback_url: "https://example.com/cb",
        },
      };

      const result = resolveSenderPin(payload);
      expect(result.ok).toBe(false);
      if (!result.ok && result.error) {
        expect(result.error.code).toBe("sender_org_forbidden");
        expect(result.error.message).toContain("not authorized for organization");
      }
    });

    it("rejects pinned sender_id when channel mismatches", () => {
      setEnvYamlForTests({
        version: 1,
        senders: [
          {
            id: "ses-email",
            channel: "email",
            provider: "ses",
            weight: 1,
            enabled: true,
          },
        ],
      });

      const payload: DispatchPayload = {
        campaign_id: "c-1",
        channel: "whatsapp",
        user_ids: ["u-1"],
        content: { text_body: "Hi" },
        metadata: {
          sender_id: "ses-email",
          organization_id: "org-1",
          analytics_callback_url: "https://example.com/cb",
        },
      };

      const result = resolveSenderPin(payload);
      expect(result.ok).toBe(false);
      if (!result.ok && result.error) {
        expect(result.error.code).toBe("invalid_sender_channel");
        expect(result.error.message).toContain("whatsapp");
      }
    });
  });

  describe("resolveSenderChainForRecipient", () => {
    it("returns pinned sender only when sender_strict is true", () => {
      setEnvYamlForTests({
        version: 1,
        senders: [
          {
            id: "ses-1",
            channel: "email",
            provider: "ses",
            weight: 1,
            enabled: true,
          },
          {
            id: "sg-1",
            channel: "email",
            provider: "sendgrid",
            sendgrid: { api_key: "SG.test-key" },
            weight: 1,
            enabled: true,
          },
        ],
      });

      const chain = resolveSenderChainForRecipient("user-1", "email", "org-1", {
        sender_id: "ses-1",
        sender_strict: true,
      });

      expect(chain.length).toBe(1);
      expect(chain[0]?.config.id).toBe("ses-1");
    });

    it("returns pinned sender first with other senders as fallbacks when sender_strict is false", () => {
      setEnvYamlForTests({
        version: 1,
        senders: [
          {
            id: "ses-1",
            channel: "email",
            provider: "ses",
            weight: 1,
            enabled: true,
          },
          {
            id: "sg-1",
            channel: "email",
            provider: "sendgrid",
            sendgrid: { api_key: "SG.test-key" },
            weight: 1,
            enabled: true,
          },
        ],
      });

      const chain = resolveSenderChainForRecipient("user-1", "email", "org-1", {
        sender_id: "ses-1",
        sender_strict: false,
      });

      expect(chain.length).toBe(2);
      expect(chain[0]?.config.id).toBe("ses-1");
      expect(chain[1]?.config.id).toBe("sg-1");
    });
  });

  describe("Multi-Key Inbound Webhook Discovery", () => {
    it("aggregates SendGrid public keys from default env and multiple senders", () => {
      process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY = "key-default";
      process.env.SG_KEY_ALT = "key-alt";

      setEnvYamlForTests({
        version: 1,
        senders: [
          {
            id: "sg-1",
            channel: "email",
            provider: "sendgrid",
            weight: 1,
            enabled: true,
            sendgrid: {
              api_key: "SG.fake",
              event_webhook_public_key: "key-sender-direct",
            },
          },
          {
            id: "sg-2",
            channel: "email",
            provider: "sendgrid",
            weight: 1,
            enabled: true,
            sendgrid: {
              api_key: "SG.fake",
              event_webhook_public_key_env: "SG_KEY_ALT",
            },
          },
        ],
      });

      const keys = getAllSendGridPublicKeys();
      expect(keys).toContain("key-default");
      expect(keys).toContain("key-sender-direct");
      expect(keys).toContain("key-alt");
      expect(keys.length).toBe(3);

      delete process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
      delete process.env.SG_KEY_ALT;
    });

    it("aggregates Gupshup webhook secrets from default env and senders", () => {
      process.env.GUPSHUP_WEBHOOK_SECRET = "secret-default";
      process.env.GS_SECRET_2 = "secret-2";

      setEnvYamlForTests({
        version: 1,
        senders: [
          {
            id: "wa-1",
            channel: "whatsapp",
            provider: "gupshup",
            weight: 1,
            enabled: true,
            gupshup: {
              api_key: "fake-key",
              src_name: "src",
              source: "12345",
              webhook_secret_env: "GS_SECRET_2",
            },
          },
        ],
      });

      const secrets = getAllGupshupWebhookSecrets();
      expect(secrets).toContain("secret-default");
      expect(secrets).toContain("secret-2");
      expect(secrets.length).toBe(2);

      delete process.env.GUPSHUP_WEBHOOK_SECRET;
      delete process.env.GS_SECRET_2;
    });
  });

  describe("Freshchat WhatsApp Multi-Sender Routing", () => {
    it("resolves and pins Freshchat WhatsApp senders cleanly", () => {
      setEnvYamlForTests({
        version: 1,
        senders: [
          {
            id: "freshchat-primary",
            channel: "whatsapp",
            provider: "freshchat",
            from: "+919876543210",
            weight: 2,
            enabled: true,
            freshchat: {
              api_key: "fc-key-1",
              api_endpoint: "https://api.freshchat.com/v2/outbound-messages/whatsapp",
              from_number: "+919876543210",
              namespace: "fc-ns-1",
            },
          },
          {
            id: "gupshup-backup",
            channel: "whatsapp",
            provider: "gupshup",
            weight: 1,
            enabled: true,
            gupshup: {
              api_key: "gs-key-1",
              src_name: "gs-bot",
              source: "919999999999",
            },
          },
        ],
      });

      const payload: DispatchPayload = {
        campaign_id: "c-wa-1",
        channel: "whatsapp",
        user_ids: ["u-wa-1"],
        content: { template_id: "winter_offer" },
        metadata: {
          sender_id: "freshchat-primary",
          organization_id: "org-1",
          analytics_callback_url: "https://example.com/cb",
        },
      };

      const pinResult = resolveSenderPin(payload);
      expect(pinResult.ok).toBe(true);

      const chain = resolveSenderChainForRecipient("u-wa-1", "whatsapp", "org-1", {
        sender_id: "freshchat-primary",
      });
      expect(chain.length).toBe(1);
      expect(chain[0]?.config.id).toBe("freshchat-primary");
      expect(chain[0]?.config.provider).toBe("freshchat");
    });
  });

  describe("PII Scrubbing", () => {
    it("scrubs email addresses and phone numbers from error/metadata objects", () => {
      const dirty = {
        sender_id: "ses-1",
        bounce_reason: "550 5.1.1 User unknown: test.recipient@example.com with phone +14155552671",
        nested: {
          ip: "192.168.1.100",
          error: "failed to send to user@domain.org",
        },
      };

      const clean = scrubPii(dirty);
      expect(clean.sender_id).toBe("ses-1");
      expect(clean.bounce_reason).not.toContain("test.recipient@example.com");
      expect(clean.bounce_reason).toContain("[REDACTED]");
      expect(clean.nested.ip).toBe("[REDACTED]");
      expect(clean.nested.error).toContain("[REDACTED]");
    });
  });
});
