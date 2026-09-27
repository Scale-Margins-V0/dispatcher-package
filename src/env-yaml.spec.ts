import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadEnvYaml,
  ensureEnvYamlValid,
  resetEnvYamlForTests,
  synthesizeBackCompatEnvYaml,
} from "./env-yaml.js";

describe("env-yaml", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetEnvYamlForTests();
    delete process.env.ENV_YAML_PATH;
  });

  it("synthesizes back-compat configuration when no .env.yaml exists", () => {
    process.env.EMAIL_PROVIDER = "ses";
    process.env.FROM_EMAIL = "test@example.com";
    const cfg = synthesizeBackCompatEnvYaml();
    expect(cfg.version).toBe(1);
    expect(cfg.senders.length).toBeGreaterThanOrEqual(1);
    expect(cfg.senders[0]?.provider).toBe("ses");
    expect(cfg.senders[0]?.from).toBe("test@example.com");
  });

  it("loads and validates default configuration cleanly with SES", () => {
    process.env.EMAIL_PROVIDER = "ses";
    process.env.FROM_EMAIL = "test@example.com";
    resetEnvYamlForTests();
    const cfg = loadEnvYaml();
    expect(cfg.version).toBe(1);
    expect(() => ensureEnvYamlValid()).not.toThrow();
  });

  it("validates SendGrid requirements properly", () => {
    process.env.EMAIL_PROVIDER = "sendgrid";
    delete process.env.SENDGRID_API_KEY;
    resetEnvYamlForTests();
    expect(() => ensureEnvYamlValid()).toThrow("SendGrid sender");

    process.env.SENDGRID_API_KEY = "SG.test-key";
    resetEnvYamlForTests();
    expect(() => ensureEnvYamlValid()).not.toThrow();
  });
});

describe("user_lookup alongside senders", () => {
  const yamlPath = join(tmpdir(), `env-yaml-lookup-${process.pid}.yaml`);

  afterEach(() => {
    resetEnvYamlForTests();
    delete process.env.ENV_YAML_PATH;
    if (existsSync(yamlPath)) unlinkSync(yamlPath);
  });

  function write(body: string): void {
    writeFileSync(yamlPath, body);
    process.env.ENV_YAML_PATH = yamlPath;
    resetEnvYamlForTests();
  }

  // Regression: an empty senders list used to discard the whole parsed file,
  // so configuring lookup here while keeping one sender in .env silently did
  // nothing. The two concerns are independent.
  it("keeps user_lookup when there are no senders", () => {
    write(`
version: 1
user_lookup:
  mode: network
  network: { url: "https://api.example.com/lookup", token: "t" }
  fields: { email: email }
senders: []
`);
    expect(loadEnvYaml().user_lookup).toMatchObject({ mode: "network" });
  });

  it("keeps user_lookup when senders are present", () => {
    write(`
version: 1
user_lookup: { mode: mock }
senders:
  - id: s1
    channel: email
    provider: ses
    from: "a@b.com"
`);
    const cfg = loadEnvYaml();
    expect(cfg.user_lookup).toEqual({ mode: "mock" });
    expect(cfg.senders).toHaveLength(1);
  });

  it("leaves user_lookup undefined when the file omits it", () => {
    write("version: 1\nsenders: []\n");
    expect(loadEnvYaml().user_lookup).toBeUndefined();
  });

  // Same trap as user_lookup above, one block over. Every optional top-level
  // key has to be carried through the no-senders branch, or it is silently
  // dropped — and an Atlas key that vanishes takes the whole data-plane with it.
  it("keeps dispatcher when there are no senders", () => {
    write(`
version: 1
dispatcher:
  port: 8080
  atlas_key: "abcdefghijklmnopqrstuvwxyz0123456789"
senders: []
`);
    expect(loadEnvYaml().dispatcher).toMatchObject({ port: 8080 });
  });

  it("keeps dispatcher alongside senders and user_lookup", () => {
    write(`
version: 1
user_lookup: { mode: mock }
dispatcher: { public_url: "https://d.example.com" }
senders:
  - id: s1
    channel: email
    provider: ses
    from: "a@b.com"
`);
    const cfg = loadEnvYaml();
    expect(cfg.dispatcher).toEqual({ public_url: "https://d.example.com" });
    expect(cfg.user_lookup).toEqual({ mode: "mock" });
    expect(cfg.senders).toHaveLength(1);
  });

  it("rejects an unknown key inside dispatcher rather than ignoring it", () => {
    write("version: 1\nsenders: []\ndispatcher: { atlas_keys: oops }\n");
    expect(() => loadEnvYaml()).toThrow();
  });
});
