/**
 * `authBaseURL()` feeds Better Auth's `baseURL`. A path leaking in from the
 * UNSUBSCRIBE_URL_BASE fallback moves every auth route under it, so
 * /admin/api/auth/* returns a bare 404 and admin sign-in fails silently.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authBaseURL, authTrustedOrigins } from "./index.js";

const KEYS = [
  "DISPATCHER_PUBLIC_URL",
  "UNSUBSCRIBE_URL_BASE",
  "DISPATCHER_TRUSTED_ORIGINS",
  "PORT",
  "NODE_ENV",
] as const;

let saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("authBaseURL", () => {
  it("defaults to localhost on the configured port", () => {
    process.env.PORT = "3100";
    expect(authBaseURL()).toBe("http://localhost:3100");
  });

  it("takes DISPATCHER_PUBLIC_URL verbatim, minus trailing slashes", () => {
    process.env.DISPATCHER_PUBLIC_URL = "https://dispatcher.example.com/";
    expect(authBaseURL()).toBe("https://dispatcher.example.com");
  });

  it("keeps a path on DISPATCHER_PUBLIC_URL — sub-path mounts are legitimate", () => {
    process.env.DISPATCHER_PUBLIC_URL = "https://example.com/dispatch";
    expect(authBaseURL()).toBe("https://example.com/dispatch");
  });

  it("strips the path from the UNSUBSCRIBE_URL_BASE fallback", () => {
    // Regression: this exact value 404'd every /admin/api/auth/* route.
    process.env.UNSUBSCRIBE_URL_BASE = "http://localhost:3100/unsubscribe";
    expect(authBaseURL()).toBe("http://localhost:3100");
  });

  it("uses the fallback origin when it has no path", () => {
    process.env.UNSUBSCRIBE_URL_BASE = "https://mail.example.com";
    expect(authBaseURL()).toBe("https://mail.example.com");
  });

  it("prefers DISPATCHER_PUBLIC_URL over the fallback", () => {
    process.env.DISPATCHER_PUBLIC_URL = "https://console.example.com";
    process.env.UNSUBSCRIBE_URL_BASE = "https://mail.example.com/unsubscribe";
    expect(authBaseURL()).toBe("https://console.example.com");
  });

  it("falls back to localhost when the fallback is not an absolute URL", () => {
    process.env.UNSUBSCRIBE_URL_BASE = "your-domain.com";
    process.env.PORT = "4000";
    expect(authBaseURL()).toBe("http://localhost:4000");
  });
});

describe("authTrustedOrigins", () => {
  it("normalizes configured entries to origins", () => {
    process.env.NODE_ENV = "production";
    process.env.DISPATCHER_PUBLIC_URL = "https://console.example.com";
    process.env.DISPATCHER_TRUSTED_ORIGINS =
      "https://ops.example.com/admin, https://other.example.com";
    expect(authTrustedOrigins().sort()).toEqual([
      "https://console.example.com",
      "https://ops.example.com",
      "https://other.example.com",
    ]);
  });

  it("reduces a sub-path public URL to its origin — Origin headers carry no path", () => {
    process.env.NODE_ENV = "production";
    process.env.DISPATCHER_PUBLIC_URL = "https://example.com/dispatch";
    expect(authTrustedOrigins()).toEqual(["https://example.com"]);
  });

  it("trusts the Vite dev server outside production", () => {
    process.env.DISPATCHER_PUBLIC_URL = "http://localhost:3100";
    expect(authTrustedOrigins()).toContain("http://localhost:5173");
  });
});
