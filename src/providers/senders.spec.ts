import { describe, expect, it, beforeEach } from "vitest";
import {
  classifyError,
  hrwScore,
  orderForRecipient,
  registry,
  resolveSenderChainForRecipient,
  resolveSenderPin,
  sendWithFailover,
} from "./senders.js";
import { resetEnvYamlForTests } from "../env-yaml.js";
import type { Sender } from "./types.js";

describe("providers/senders", () => {
  beforeEach(() => {
    resetEnvYamlForTests();
    registry.resetForTests();
  });

  describe("HRW Rendezvous Hashing", () => {
    it("is deterministic for the same userId and sender pool", () => {
      const senders: Sender[] = [
        { config: { id: "ses-1", channel: "email", provider: "ses", weight: 1, enabled: true }, provider: {} as any },
        { config: { id: "sg-1", channel: "email", provider: "sendgrid", weight: 1, enabled: true }, provider: {} as any },
      ];

      const order1 = orderForRecipient("usr_12345", senders);
      const order2 = orderForRecipient("usr_12345", senders);

      expect(order1.map((s) => s.config.id)).toEqual(order2.map((s) => s.config.id));
    });

    it("distributes evenly across 10,000 synthetic IDs with equal weights", () => {
      const senders: Sender[] = [
        { config: { id: "sender-a", channel: "email", provider: "ses", weight: 1, enabled: true }, provider: {} as any },
        { config: { id: "sender-b", channel: "email", provider: "sendgrid", weight: 1, enabled: true }, provider: {} as any },
      ];

      const counts: Record<string, number> = { "sender-a": 0, "sender-b": 0 };

      for (let i = 0; i < 10000; i++) {
        const order = orderForRecipient(`user_${i}`, senders);
        const topId = order[0]!.config.id;
        counts[topId] = (counts[topId] || 0) + 1;
      }

      // Expected ~5000 each (allow reasonable statistical margin e.g. 4500 - 5500)
      expect(counts["sender-a"]).toBeGreaterThan(4500);
      expect(counts["sender-a"]).toBeLessThan(5500);
      expect(counts["sender-b"]).toBeGreaterThan(4500);
      expect(counts["sender-b"]).toBeLessThan(5500);
    });

    it("respects weights (2:1 distribution)", () => {
      const senders: Sender[] = [
        { config: { id: "sender-heavy", channel: "email", provider: "ses", weight: 2, enabled: true }, provider: {} as any },
        { config: { id: "sender-light", channel: "email", provider: "sendgrid", weight: 1, enabled: true }, provider: {} as any },
      ];

      const counts: Record<string, number> = { "sender-heavy": 0, "sender-light": 0 };

      for (let i = 0; i < 10000; i++) {
        const order = orderForRecipient(`user_${i}`, senders);
        const topId = order[0]!.config.id;
        counts[topId] = (counts[topId] || 0) + 1;
      }

      // 2:1 ratio means heavy gets ~6666 (6000-7300) and light gets ~3333 (2700-4000)
      expect(counts["sender-heavy"]).toBeGreaterThan(6000);
      expect(counts["sender-light"]).toBeGreaterThan(2700);
    });
  });

  describe("Error Classification", () => {
    it("classifies transient network errors as failover: true, trips_breaker: true", () => {
      const res = classifyError(new Error("ECONNRESET"), "email");
      expect(res.failover).toBe(true);
      expect(res.trips_breaker).toBe(true);
      expect(res.category).toBe("network_transient");
    });

    it("classifies rate limit errors as failover: true, trips_breaker: true", () => {
      const res = classifyError(new Error("429 Too Many Requests"), "email");
      expect(res.failover).toBe(true);
      expect(res.trips_breaker).toBe(true);
      expect(res.category).toBe("rate_limited");
    });

    it("classifies timeouts as terminal by default (on_timeout: false)", () => {
      const res = classifyError(new Error("ETIMEDOUT"), "email");
      expect(res.failover).toBe(false);
      expect(res.trips_breaker).toBe(true);
      expect(res.category).toBe("network_timeout");
    });

    it("classifies unverified sender as terminal by default", () => {
      const res = classifyError(new Error("Email address is not verified"), "email");
      expect(res.failover).toBe(false);
      expect(res.trips_breaker).toBe(true);
      expect(res.category).toBe("unverified_sender");
    });

    it("classifies unknown/syntax errors as terminal without tripping breaker", () => {
      const res = classifyError(new Error("Invalid email syntax foo@bar"), "email");
      expect(res.failover).toBe(false);
      expect(res.trips_breaker).toBe(false);
      expect(res.category).toBe("terminal_error");
    });
  });

  describe("Circuit Breaker & Failover Loop", () => {
    it("fails over on transient error and succeeds on backup sender", async () => {
      let firstCalled = false;
      let secondCalled = false;

      const mockSender1: Sender = {
        config: { id: "ses-primary", channel: "email", provider: "ses", weight: 1, enabled: true },
        provider: {
          send: async () => {
            firstCalled = true;
            return { success: false, error: "ECONNRESET connection reset by peer" };
          },
        },
      };

      const mockSender2: Sender = {
        config: { id: "sg-backup", channel: "email", provider: "sendgrid", weight: 1, enabled: true },
        provider: {
          send: async () => {
            secondCalled = true;
            return { success: true, messageId: "msg_1234" };
          },
        },
      };

      const result = await sendWithFailover(
        { to: "test@example.com", from: "noreply@example.com", subject: "Hi", html: "<p>Hi</p>" },
        [mockSender1, mockSender2],
        "email"
      );

      expect(firstCalled).toBe(true);
      expect(secondCalled).toBe(true);
      expect(result.success).toBe(true);
      expect(result.finalSender.config.id).toBe("sg-backup");
      expect(result.attempts.length).toBe(2);
      expect(result.attempts[0]?.success).toBe(false);
      expect(result.attempts[1]?.success).toBe(true);
    });

    it("stops on terminal error without attempting backup", async () => {
      let firstCalled = false;
      let secondCalled = false;

      const mockSender1: Sender = {
        config: { id: "ses-primary", channel: "email", provider: "ses", weight: 1, enabled: true },
        provider: {
          send: async () => {
            firstCalled = true;
            return { success: false, error: "Invalid email syntax" };
          },
        },
      };

      const mockSender2: Sender = {
        config: { id: "sg-backup", channel: "email", provider: "sendgrid", weight: 1, enabled: true },
        provider: {
          send: async () => {
            secondCalled = true;
            return { success: true, messageId: "msg_1234" };
          },
        },
      };

      const result = await sendWithFailover(
        { to: "test@example.com", from: "noreply@example.com", subject: "Hi", html: "<p>Hi</p>" },
        [mockSender1, mockSender2],
        "email"
      );

      expect(firstCalled).toBe(true);
      expect(secondCalled).toBe(false);
      expect(result.success).toBe(false);
      expect(result.attempts.length).toBe(1);
    });
  });
});
