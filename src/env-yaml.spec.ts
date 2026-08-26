import { describe, expect, it, beforeEach } from "vitest";
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
