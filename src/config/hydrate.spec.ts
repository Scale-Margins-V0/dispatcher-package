/**
 * Hydration from `.env.yaml` into `process.env`.
 *
 * The load-bearing test is the first one in "precedence": a real environment
 * variable must survive. Kubernetes injects rotated secrets that way, and a
 * mounted file carrying a stale value must never win over them.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvYamlForTests } from "../env-yaml.js";
import { BINDINGS, ENV_ONLY } from "./bindings.js";
import { hydrateEnvFromYaml } from "./hydrate.js";

let dir: string;
const originalEnv = { ...process.env };

/** Write a .env.yaml and point the loader at it. */
function useYaml(body: string): void {
  const path = join(dir, ".env.yaml");
  writeFileSync(path, body);
  process.env.ENV_YAML_PATH = path;
  resetEnvYamlForTests();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hydrate-"));
  process.env = { ...originalEnv };
  resetEnvYamlForTests();
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetEnvYamlForTests();
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

describe("precedence", () => {
  // The one that matters: a Kubernetes Secret must beat a mounted file.
  it("never overwrites a variable already set in the environment", () => {
    process.env.SCALEMARGIN_DISPATCH_SECRET = "from-kubernetes";
    useYaml(`
version: 1
senders: []
scalemargin:
  dispatch_secret: from-the-file
`);
    const result = hydrateEnvFromYaml();
    expect(process.env.SCALEMARGIN_DISPATCH_SECRET).toBe("from-kubernetes");
    expect(result.skipped).toContain("SCALEMARGIN_DISPATCH_SECRET");
    expect(result.applied).not.toContain("SCALEMARGIN_DISPATCH_SECRET");
  });

  // An empty string is how docker-compose passes through an unset variable.
  it("treats an empty environment variable as unset", () => {
    process.env.LOGO_URL = "";
    useYaml(`
version: 1
senders: []
links:
  logo_url: https://cdn.example.com/logo.png
`);
    hydrateEnvFromYaml();
    expect(process.env.LOGO_URL).toBe("https://cdn.example.com/logo.png");
  });

  it("lets a typed block override the env: passthrough, and reports it", () => {
    useYaml(`
version: 1
senders: []
env:
  DISPATCHER_LOG_LEVEL: error
dispatcher:
  logging:
    level: debug
`);
    const result = hydrateEnvFromYaml();
    expect(process.env.DISPATCHER_LOG_LEVEL).toBe("debug");
    expect(result.collisions).toContain("DISPATCHER_LOG_LEVEL");
  });
});

describe("flattening YAML into environment strings", () => {
  it("joins a list with commas, matching every existing parser", () => {
    useYaml(`
version: 1
senders: []
dispatcher:
  admin:
    trusted_origins:
      - https://a.example
      - https://b.example
`);
    hydrateEnvFromYaml();
    expect(process.env.DISPATCHER_TRUSTED_ORIGINS).toBe("https://a.example,https://b.example");
  });

  it("accepts the comma-separated string someone pastes from the old .env", () => {
    useYaml(`
version: 1
senders: []
dispatcher:
  admin:
    trusted_origins: "https://a.example,https://b.example"
`);
    hydrateEnvFromYaml();
    expect(process.env.DISPATCHER_TRUSTED_ORIGINS).toBe("https://a.example,https://b.example");
  });

  it("stringifies numbers and booleans", () => {
    useYaml(`
version: 1
senders: []
dispatcher:
  retention:
    log_days: 14
  telemetry:
    disabled: true
`);
    hydrateEnvFromYaml();
    expect(process.env.DISPATCHER_LOG_RETENTION_DAYS).toBe("14");
    expect(process.env.DISPATCHER_TELEMETRY_DISABLED).toBe("true");
  });

  it("passes env: values through verbatim, coercing non-strings", () => {
    useYaml(`
version: 1
senders: []
env:
  SENDGRID_API_KEY: SG.abc123
  EVENT_BATCH_SIZE: 250
  SOME_FLAG: false
`);
    hydrateEnvFromYaml();
    expect(process.env.SENDGRID_API_KEY).toBe("SG.abc123");
    expect(process.env.EVENT_BATCH_SIZE).toBe("250");
    expect(process.env.SOME_FLAG).toBe("false");
  });
});

describe("*_env indirection", () => {
  it("dereferences the named variable rather than copying the name", () => {
    process.env.MY_SECRET_HOME = "the-real-secret";
    useYaml(`
version: 1
senders: []
scalemargin:
  analytics_secret_env: MY_SECRET_HOME
`);
    hydrateEnvFromYaml();
    expect(process.env.SCALEMARGIN_ANALYTICS_SECRET).toBe("the-real-secret");
  });

  // Setting the secret to the literal string "MY_SECRET_HOME" would fail at
  // the first HMAC check, far from the cause.
  it("reports a dangling reference instead of setting the name as the value", () => {
    useYaml(`
version: 1
senders: []
scalemargin:
  analytics_secret_env: NOT_SET_ANYWHERE
`);
    const result = hydrateEnvFromYaml();
    expect(process.env.SCALEMARGIN_ANALYTICS_SECRET).toBeUndefined();
    expect(result.dangling).toEqual([
      { env: "SCALEMARGIN_ANALYTICS_SECRET", reference: "NOT_SET_ANYWHERE" },
    ]);
  });

  it("prefers a literal value over a reference for the same setting", () => {
    process.env.OTHER = "from-reference";
    useYaml(`
version: 1
senders: []
scalemargin:
  dispatch_secret: literal-wins
`);
    hydrateEnvFromYaml();
    expect(process.env.SCALEMARGIN_DISPATCH_SECRET).toBe("literal-wins");
  });
});

describe("degenerate files", () => {
  it("is a no-op when there is no file at all", () => {
    delete process.env.ENV_YAML_PATH;
    resetEnvYamlForTests();
    const result = hydrateEnvFromYaml();
    expect(result.applied).toEqual([]);
    expect(result.path).toBeNull();
  });

  // An empty file used to throw a schema error about the whole document.
  it("treats an empty file as no settings, not a parse failure", () => {
    useYaml("");
    expect(() => hydrateEnvFromYaml()).not.toThrow();
    expect(hydrateEnvFromYaml().applied).toEqual([]);
  });

  it("treats a comments-only file the same way", () => {
    useYaml("# nothing here yet\n");
    expect(() => hydrateEnvFromYaml()).not.toThrow();
  });

  it("rejects an unknown key inside a typed block rather than ignoring it", () => {
    useYaml(`
version: 1
senders: []
dispatcher:
  retention:
    log_dayz: 14
`);
    // Nested under dispatcher:, so this exercises the typo check itself — not
    // the moved-key guard, which would also throw and hide a regression here.
    expect(() => hydrateEnvFromYaml()).toThrow(/log_dayz/);
  });

  it("rejects an env: key that is not a legal variable name", () => {
    useYaml(`
version: 1
senders: []
env:
  "not a var": x
`);
    expect(() => hydrateEnvFromYaml()).toThrow();
  });

  it("is idempotent — a second call changes nothing", () => {
    useYaml(`
version: 1
senders: []
dispatcher:
  logging:
    level: warn
`);
    const first = hydrateEnvFromYaml();
    const second = hydrateEnvFromYaml();
    expect(first.applied).toContain("DISPATCHER_LOG_LEVEL");
    expect(second.applied).not.toContain("DISPATCHER_LOG_LEVEL");
    expect(process.env.DISPATCHER_LOG_LEVEL).toBe("warn");
  });
});

describe("the binding table", () => {
  // A binding for one of these would be silently ineffective, which is worse
  // than absent: the operator would believe it took effect.
  it("never binds a setting that must come from the environment", () => {
    const bound = new Set(BINDINGS.map((b) => b.env));
    for (const [name] of ENV_ONLY) {
      expect(bound.has(name), `${name} must not be bindable from .env.yaml`).toBe(false);
    }
  });

  it("uses SCREAMING_SNAKE names, as every reader expects", () => {
    for (const b of BINDINGS) {
      expect(b.env, `${b.env} is not a valid env var name`).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  // Two literal bindings on one variable would make the winner depend on
  // table order. Literal + `*_env` on the same variable is the intended pair.
  it("has at most one literal binding per environment variable", () => {
    const seen = new Map<string, number>();
    for (const b of BINDINGS.filter((x) => !x.indirect)) {
      seen.set(b.env, (seen.get(b.env) ?? 0) + 1);
    }
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1);
    // DISPATCHER_DB_URL is the deliberate exception: `url` and `file` are
    // mutually exclusive by dialect and resolveDbEnv() reads both from it.
    expect(duplicated.map(([k]) => k)).toEqual(["DISPATCHER_DB_URL"]);
  });
});

// What makes this safe to ship.
describe("a deployment with no .env.yaml blocks", () => {
  it("leaves every setting to the environment, exactly as before", () => {
    process.env.SCALEMARGIN_DISPATCH_SECRET = "env-dispatch";
    process.env.DISPATCHER_LOG_LEVEL = "info";
    useYaml("version: 1\nsenders: []\n");

    const result = hydrateEnvFromYaml();
    expect(result.applied).toEqual([]);
    expect(process.env.SCALEMARGIN_DISPATCH_SECRET).toBe("env-dispatch");
    expect(process.env.DISPATCHER_LOG_LEVEL).toBe("info");
  });
});

// ── The system blocks moved under `dispatcher:` ─────────────────────────────
//
// The top-level schema is a plain z.object, which silently strips keys it does
// not know. Without these guards, a file still on the old layout would lose
// its settings without a word — `admin.auth_secret` gone means every session
// invalidates on the next redeploy.
describe("the old top-level layout", () => {
  it.each([
    ["state_database", "dispatcher.database", "dialect: postgres"],
    ["admin", "dispatcher.admin", "auth_secret: s"],
    ["retention", "dispatcher.retention", 'message_id_ttl: "5d"'],
    ["logging", "dispatcher.logging", "level: debug"],
    ["telemetry", "dispatcher.telemetry", "disabled: true"],
  ])("rejects top-level %s and names where it moved (%s)", (oldKey, newPath, body) => {
    useYaml(`version: 1\nsenders: []\n${oldKey}:\n  ${body}\n`);
    expect(() => hydrateEnvFromYaml()).toThrow(new RegExp(newPath.replace(".", "\\.")));
  });

  it("accepts the same settings once nested under dispatcher:", () => {
    // vitest.config.ts sets this globally, and a real environment variable
    // always beats the file — so without clearing it this would assert the
    // precedence rule, not the nested binding it means to test.
    delete process.env.DISPATCHER_MESSAGE_ID_TTL;
    useYaml(`
version: 1
senders: []
dispatcher:
  database: { dialect: postgres }
  admin: { auth_secret: s }
  retention: { message_id_ttl: "5d" }
  logging: { level: debug }
  telemetry: { disabled: true }
`);
    expect(() => hydrateEnvFromYaml()).not.toThrow();
    expect(process.env.DISPATCHER_DB_DIALECT).toBe("postgres");
    expect(process.env.BETTER_AUTH_SECRET).toBe("s");
    expect(process.env.DISPATCHER_MESSAGE_ID_TTL).toBe("5d");
    expect(process.env.DISPATCHER_LOG_LEVEL).toBe("debug");
    expect(process.env.DISPATCHER_TELEMETRY_DISABLED).toBe("true");
  });
});

// ── The four settings that previously had no typed home ─────────────────────
describe("newly bound settings", () => {
  it("binds dispatcher.logs_api_token", () => {
    useYaml(`version: 1\nsenders: []\ndispatcher:\n  logs_api_token: tok_123\n`);
    hydrateEnvFromYaml();
    expect(process.env.DISPATCHER_LOGS_API_TOKEN).toBe("tok_123");
  });

  it("dereferences dispatcher.logs_api_token_env", () => {
    process.env.WHERE_THE_TOKEN_LIVES = "tok_from_ref";
    useYaml(`version: 1\nsenders: []\ndispatcher:\n  logs_api_token_env: WHERE_THE_TOKEN_LIVES\n`);
    hydrateEnvFromYaml();
    expect(process.env.DISPATCHER_LOGS_API_TOKEN).toBe("tok_from_ref");
  });

  // Same guard as atlas_key: silently preferring one would leave the operator
  // believing the other was in use.
  it("rejects logs_api_token and logs_api_token_env together", () => {
    useYaml(`version: 1\nsenders: []\ndispatcher:\n  logs_api_token: a\n  logs_api_token_env: B\n`);
    expect(() => hydrateEnvFromYaml()).toThrow(/not both/);
  });

  it("binds the two admin file paths", () => {
    useYaml(`
version: 1
senders: []
dispatcher:
  admin:
    auth_secret_file: /var/lib/dispatcher/auth-secret
    credentials_file: /var/lib/dispatcher/admin.txt
`);
    hydrateEnvFromYaml();
    expect(process.env.DISPATCHER_AUTH_SECRET_FILE).toBe("/var/lib/dispatcher/auth-secret");
    expect(process.env.DISPATCHER_ADMIN_CREDENTIALS_FILE).toBe("/var/lib/dispatcher/admin.txt");
  });

  it("binds events.config_path", () => {
    useYaml(`version: 1\nsenders: []\nevents:\n  config_path: /etc/dispatcher/events.yaml\n`);
    hydrateEnvFromYaml();
    expect(process.env.EVENTS_CONFIG_PATH).toBe("/etc/dispatcher/events.yaml");
  });
});
