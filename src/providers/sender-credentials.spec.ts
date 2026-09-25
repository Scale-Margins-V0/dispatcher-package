/**
 * Credentials come from each sender — its inline value or the variable its
 * `*_env` names — never from a provider-wide GUPSHUP_* / SENDGRID_* variable.
 * These pin that end to end: boot validation, the provider config, the
 * registry, send-time errors and diagnostics all agree, and every failure
 * names the sender and the field to set.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureEnvYamlValid, resetEnvYamlForTests, setEnvYamlForTests } from "../env-yaml.js";
import { buildDiagnosticsReport } from "../ops/diagnostics.js";
import { gupshupConfigFromSender, sendGupshupWhatsApp } from "./gupshup-whatsapp.js";
import { SendGridProvider } from "./sendgrid.js";
import { senderCredentials } from "./sender-credentials.js";
import { registry } from "./senders.js";
import type { SenderConfig } from "./types.js";

const sender = (x: Partial<SenderConfig> & Pick<SenderConfig, "id" | "provider">): SenderConfig =>
  ({
    channel: x.provider === "sendgrid" || x.provider === "ses" ? "email" : "whatsapp",
    weight: 1,
    enabled: true,
    ...x,
  }) as SenderConfig;

function use(senders: SenderConfig[]) {
  setEnvYamlForTests({ version: 1, senders } as never);
  registry.resetForTests();
}

const originalEnv = { ...process.env };
beforeEach(() => {
  process.env = { ...originalEnv };
  // The provider-wide variables are set on purpose: nothing below may read them.
  process.env.SENDGRID_API_KEY = "SG.global-should-never-be-used";
  process.env.GUPSHUP_USER_ID = "global-user";
  process.env.GUPSHUP_PASSWORD = "global-pass";
  process.env.GUPSHUP_API_KEY = "global-key";
  process.env.GUPSHUP_MESSAGE_TYPE = "GLOBAL";
  resetEnvYamlForTests();
  registry.resetForTests();
});
afterEach(() => {
  process.env = { ...originalEnv };
  resetEnvYamlForTests();
  registry.resetForTests();
  vi.restoreAllMocks();
});

describe("senderCredentials", () => {
  it("reads inline values, and names the field", () => {
    const r = senderCredentials(sender({ id: "sg", provider: "sendgrid", from: "a@b.co", sendgrid: { api_key: "SG.x" } }));
    expect(r.satisfied).toBe(true);
    expect(r.sets[0]!.checks).toEqual([{ source: "sendgrid.api_key", present: true }]);
  });

  it("reads the variable an _env names — and says when it is empty", () => {
    process.env.MY_SG = "SG.y";
    expect(senderCredentials(sender({ id: "sg", provider: "sendgrid", sendgrid: { api_key_env: "MY_SG" } })).satisfied).toBe(true);
    const r = senderCredentials(sender({ id: "sg", provider: "sendgrid", sendgrid: { api_key_env: "NOPE_SG" } }));
    expect(r.satisfied).toBe(false);
    expect(r.problem).toBe("SendGrid sender 'sg' has no API key — sendgrid.api_key_env names NOPE_SG, which is not set");
  });

  it("never counts the provider-wide variable as the sender's key", () => {
    const r = senderCredentials(sender({ id: "sg", provider: "sendgrid", sendgrid: {} }));
    expect(r.satisfied).toBe(false);
    expect(r.problem).toContain("set sendgrid.api_key (or sendgrid.api_key_env)");
  });

  it("SES: no keys means IAM role; half a pair is a mistake", () => {
    expect(senderCredentials(sender({ id: "s", provider: "ses", ses: { region: "ap-south-1" } })).satisfied).toBe(true);
    const half = senderCredentials(sender({ id: "s", provider: "ses", ses: { access_key_id: "AKIA" } }));
    expect(half.satisfied).toBe(false);
    expect(half.problem).toContain("ses.secret_access_key");
  });

  it("Gupshup: either API key + src_name, or user id + password — and says both options", () => {
    const ent = senderCredentials(sender({ id: "g", provider: "gupshup", gupshup: { user_id: "u", password: "p" } }));
    expect(ent.satisfied).toBe(true);
    expect(ent.notes).toEqual([]);

    const keyOnly = senderCredentials(sender({ id: "g", provider: "gupshup", gupshup: { api_key: "k", src_name: "App" } }));
    expect(keyOnly.satisfied).toBe(true);
    expect(keyOnly.notes[0]).toContain("media and text");

    const none = senderCredentials(sender({ id: "g", provider: "gupshup", gupshup: { api_key: "k" } }));
    expect(none.satisfied).toBe(false);
    expect(none.problem).toContain("Either API key: set gupshup.src_name");
    expect(none.problem).toContain("Or enterprise: set gupshup.user_id");
  });
});

describe("boot validation", () => {
  it("accepts an enterprise Gupshup sender that does not declare mode", () => {
    // Used to fail: validation assumed mode api_key and demanded a key.
    use([sender({ id: "wa", provider: "gupshup", gupshup: { user_id: "u", password: "p", source: "91999" } })]);
    expect(() => ensureEnvYamlValid()).not.toThrow();
  });

  it("names the sender and the field when credentials are missing", () => {
    use([sender({ id: "wa", provider: "gupshup", gupshup: { source: "91999" } })]);
    expect(() => ensureEnvYamlValid()).toThrow("Gupshup sender 'wa' has no usable credentials");
  });
});

describe("Gupshup config comes only from the sender", () => {
  it("ignores GUPSHUP_* even when the sender lacks a field", () => {
    const cfg = gupshupConfigFromSender(sender({ id: "wa", provider: "gupshup", gupshup: { api_key: "own", src_name: "App" } }));
    expect(cfg).toMatchObject({ senderId: "wa", mode: "apikey", apiKey: "own", msgType: "HSM" });
    expect(cfg.userId).toBeUndefined();
    expect(cfg.password).toBeUndefined();
  });

  it("uses the sender's own enterprise credentials and message type", () => {
    process.env.WA_PASS = "from-named-var";
    const cfg = gupshupConfigFromSender(
      sender({ id: "wa", provider: "gupshup", gupshup: { user_id: "u1", password_env: "WA_PASS", message_type: "TEXT" } })
    );
    expect(cfg).toMatchObject({ mode: "enterprise", userId: "u1", password: "from-named-var", msgType: "TEXT" });
  });

  it("an API-key sender asked to send media fails with its own name, not a variable name", async () => {
    const cfg = gupshupConfigFromSender(sender({ id: "wa", provider: "gupshup", gupshup: { api_key: "k", src_name: "App" } }));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await sendGupshupWhatsApp({ to: "919999999999", caption: "Hi", mediaUrl: "https://x/y.png" } as never, cfg);
    expect(res.success).toBe(false);
    expect(res.error).toContain("Gupshup sender 'wa' cannot send media");
    expect(res.error).toContain("gupshup.user_id and gupshup.password");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the sender registry", () => {
  it("never borrows SENDGRID_API_KEY, and one bad sender does not break the others", async () => {
    use([
      sender({ id: "keyless", provider: "sendgrid", from: "a@b.co", sendgrid: {} }),
      sender({ id: "good", provider: "sendgrid", from: "c@b.co", sendgrid: { api_key: "SG.own" } }),
    ]);
    const ctor = vi.spyOn(SendGridProvider.prototype, "send");
    const keyless = registry.getSender("keyless")!;
    const res = await keyless.provider.send({ to: "x@y.co", from: "a@b.co", subject: "s", html: "h" });
    expect(res).toEqual({ success: false, error: expect.stringContaining("SendGrid sender 'keyless' has no API key") });
    expect(ctor).not.toHaveBeenCalled();
    expect(registry.getSender("good")!.provider).toBeInstanceOf(SendGridProvider);
  });
});

describe("diagnostics", () => {
  it("reports providers from senders — names, never values", async () => {
    delete process.env.SENDGRID_API_KEY; // gone from env: — diagnostics must still see the sender's key
    use([
      sender({ id: "sg", provider: "sendgrid", from: "a@b.co", sendgrid: { api_key: "SG.inline", event_webhook_public_key: "PK" } }),
      sender({ id: "wa", provider: "gupshup", gupshup: { user_id: "u", password: "p" } }),
    ]);
    const report = await buildDiagnosticsReport({});
    const byProvider = Object.fromEntries(report.config.providers.map((p) => [p.provider, p]));
    expect(byProvider.sendgrid).toMatchObject({
      active: true,
      state: "active",
      webhook: { verification_configured: true },
      credential_sets: [{ label: "sg · API key", variables: { "sendgrid.api_key": true }, satisfied: true }],
    });
    expect(byProvider.gupshup.state).toBe("active");
    expect(byProvider.ses.state).toBe("not_configured");
    expect(report.env.provider).toEqual({ "sendgrid.api_key": true });
    expect(JSON.stringify(report)).not.toContain("SG.inline");
    const wa = report.config.senders.find((x) => x.id === "wa")!;
    expect(wa).toMatchObject({ credentials_satisfied: true, credentials: { "gupshup.user_id": true, "gupshup.password": true } });
  });

  it("shows what is missing, by sender", async () => {
    use([sender({ id: "wa", provider: "gupshup", gupshup: { api_key: "k" } })]);
    const report = await buildDiagnosticsReport({});
    const gupshup = report.config.providers.find((p) => p.provider === "gupshup")!;
    expect(gupshup.state).toBe("incomplete");
    expect(gupshup.problems?.[0]).toContain("Gupshup sender 'wa'");
    expect(report.config.senders[0]!.credential_problem).toContain("gupshup.src_name");
  });
});
