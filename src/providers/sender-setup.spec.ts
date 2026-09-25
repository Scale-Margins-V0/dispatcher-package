/**
 * The `email:` shorthand is gone: every reader of "the" email account now asks
 * the sender registry. These pin the edge cases — which sender counts as
 * primary, what a run is labelled, what boot warns about, and that the old
 * block fails loudly instead of being silently dropped.
 */

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendInvitationEmail } from "../auth/invitations.js";
import {
  ensureEnvYamlValid,
  envYamlSchema,
  loadEnvYaml,
  resetEnvYamlForTests,
  setEnvYamlForTests,
} from "../env-yaml.js";
import { SendGridProvider } from "./sendgrid.js";
import {
  dispatchProviderLabel,
  emailSenderWarnings,
  primarySender,
  registry,
} from "./senders.js";

type SenderInput = Record<string, unknown>;

const sg = (id: string, extra: SenderInput = {}): SenderInput => ({
  id,
  channel: "email",
  provider: "sendgrid",
  from: `${id}@acme.test`,
  sendgrid: { api_key: "SG.test" },
  ...extra,
});
const ses = (id: string, extra: SenderInput = {}): SenderInput => ({
  id,
  channel: "email",
  provider: "ses",
  from: `${id}@acme.test`,
  ses: { region: "ap-south-1" },
  ...extra,
});
const wa = (id: string): SenderInput => ({
  id,
  channel: "whatsapp",
  provider: "gupshup",
  gupshup: { api_key: "k", source: "919999999999" },
});

function use(senders: SenderInput[], defaults?: { email?: string; whatsapp?: string }) {
  setEnvYamlForTests({
    version: 1,
    senders,
    ...(defaults ? { routing: { default_sender: defaults } } : {}),
  } as never);
  registry.resetForTests();
}

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.ENV_YAML_PATH;
  resetEnvYamlForTests();
  registry.resetForTests();
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetEnvYamlForTests();
  registry.resetForTests();
  vi.restoreAllMocks();
});

describe("primarySender", () => {
  it("is routing.default_sender when set", () => {
    use([sg("first"), ses("second")], { email: "second" });
    expect(primarySender("email")?.config.id).toBe("second");
  });

  it("falls back to the first enabled sender of the channel, in file order", () => {
    use([wa("wa-1"), sg("off", { enabled: false }), ses("live"), sg("later")]);
    expect(primarySender("email")?.config.id).toBe("live");
    expect(primarySender("whatsapp")?.config.id).toBe("wa-1");
  });

  it("is undefined when the channel has no sender", () => {
    use([wa("wa-1")]);
    expect(primarySender("email")).toBeUndefined();
  });

  it("ignores a default that names a sender of the other channel", () => {
    use([wa("wa-1"), sg("mail")], { email: "wa-1" });
    expect(primarySender("email")?.config.id).toBe("mail");
  });
});

describe("dispatchProviderLabel", () => {
  it("is the pinned sender id when the dispatch pins one", () => {
    use([sg("a"), ses("b")]);
    expect(dispatchProviderLabel("email", " b ")).toBe("b");
  });

  it("is the provider when the channel has one provider, else multi", () => {
    use([sg("a"), sg("b"), wa("w")]);
    expect(dispatchProviderLabel("email")).toBe("sendgrid");
    expect(dispatchProviderLabel("whatsapp")).toBe("gupshup");
    use([sg("a"), ses("b")]);
    expect(dispatchProviderLabel("email")).toBe("multi");
  });

  it("never invents a provider the deployment does not have", () => {
    use([wa("w")]);
    expect(dispatchProviderLabel("email")).toBe("none");
  });
});

describe("emailSenderWarnings", () => {
  it("is quiet for verified-looking senders", () => {
    use([sg("a")]);
    expect(emailSenderWarnings()).toEqual([]);
  });

  it("warns when there is no email sender at all", () => {
    use([wa("w")]);
    expect(emailSenderWarnings()[0]).toContain("No email sender is configured");
  });

  it("names a sender sending from the unverifiable example.com", () => {
    use([sg("a", { from: "noreply@example.com" })]);
    expect(emailSenderWarnings()[0]).toContain("'a'");
  });
});

describe("the removed `email:` block", () => {
  const yamlPath = join(tmpdir(), `env-yaml-email-${process.pid}.yaml`);
  afterEach(() => {
    if (existsSync(yamlPath)) unlinkSync(yamlPath);
  });

  it("is rejected with the senders: replacement, not silently dropped", () => {
    const result = envYamlSchema.safeParse({ version: 1, email: { provider: "sendgrid", from: "a@b.c" } });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("declare the account under `senders:`");
  });

  it("fails boot from a real file too", () => {
    writeFileSync(yamlPath, "version: 1\nemail:\n  provider: ses\n  from: a@acme.test\n");
    process.env.ENV_YAML_PATH = yamlPath;
    expect(() => loadEnvYaml()).toThrow("senders:");
  });
});

describe("email senders need their own from", () => {
  it("refuses an enabled email sender without one", () => {
    use([sg("nofrom", { from: undefined })]);
    expect(() => ensureEnvYamlValid()).toThrow("'nofrom' needs a `from:` address");
  });

  it("accepts a disabled one — it never sends", () => {
    use([sg("live"), sg("parked", { from: undefined, enabled: false })]);
    expect(() => ensureEnvYamlValid()).not.toThrow();
  });
});

describe("legacy environment variables, no senders:", () => {
  it("still build one sender, so env-only deployments keep booting", () => {
    process.env.EMAIL_PROVIDER = "sendgrid";
    process.env.FROM_EMAIL = "legacy@acme.test";
    process.env.SENDGRID_API_KEY = "SG.test";
    expect(primarySender("email")?.config).toMatchObject({
      id: "default-email",
      provider: "sendgrid",
      from: "legacy@acme.test",
    });
    expect(() => ensureEnvYamlValid()).not.toThrow();
  });
});

describe("console invitation email", () => {
  const invite = {
    email: "new@acme.test",
    invitation: { id: "inv_1" },
    organization: { name: "Acme" },
  } as never;

  it("goes through the primary email sender, as its From address", async () => {
    use([sg("a"), sg("b")], { email: "b" });
    const send = vi
      .spyOn(SendGridProvider.prototype, "send")
      .mockResolvedValue({ success: true, messageId: "m1" });
    await sendInvitationEmail(invite);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ to: "new@acme.test", from: "b@acme.test" });
  });

  it("sends nothing when there is no email sender", async () => {
    use([wa("w")]);
    const send = vi.spyOn(SendGridProvider.prototype, "send");
    await sendInvitationEmail(invite);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("unknown sender and routing keys are rejected, not silently dropped", () => {
  const parse = (senders: unknown[], routing?: unknown) =>
    envYamlSchema.safeParse({ version: 1, senders, ...(routing ? { routing } : {}) });
  const messages = (r: ReturnType<typeof parse>) => (r.success ? [] : r.error.issues.map((i) => i.message));

  it("a provider key written beside `provider:` says which block it belongs in", () => {
    const r = parse([{ ...wa("gs"), webhook_secret: "x" }]);
    expect(messages(r)).toEqual([
      "'webhook_secret' is not a sender key — it belongs inside the `gupshup:` block of sender 'gs'",
    ]);
  });

  it("a key of another provider still points at a real block", () => {
    const r = parse([{ ...sg("mail"), api_endpoint: "https://x" }]);
    expect(messages(r)[0]).toContain("belongs inside the `freshchat:` block");
  });

  it("a plain typo is named", () => {
    expect(messages(parse([{ ...sg("mail"), wieght: 3 }]))).toEqual(["unknown key 'wieght' on sender 'mail'"]);
  });

  it("typos inside a provider block or routing fail too", () => {
    expect(parse([{ ...sg("mail"), sendgrid: { api_keyy: "SG.x" } }]).success).toBe(false);
    expect(parse([sg("mail")], { default_senders: { email: "mail" } }).success).toBe(false);
  });

  it("a valid sender still parses, with defaults applied", () => {
    const r = parse([sg("mail")]);
    expect(r.success).toBe(true);
    expect(r.success && r.data.senders[0]).toMatchObject({ id: "mail", weight: 1, enabled: true });
  });
});
