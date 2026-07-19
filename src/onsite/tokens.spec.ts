import { describe, expect, it } from "vitest";
import {
  generateActivationToken,
  generateSessionSecret,
  hashSecret,
  hashesEqual,
} from "./tokens.js";
import { parseCookies, serializeSessionCookie } from "./http.js";
import { ONSITE_COOKIE_NAME } from "./config.js";

describe("onsite tokens", () => {
  it("generates unique 256-bit base64url secrets", () => {
    const a = generateActivationToken();
    const b = generateActivationToken();
    expect(a).not.toBe(b);
    // 32 random bytes → 43 base64url chars, url-safe alphabet only.
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSessionSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("hashes deterministically to 64 hex chars", () => {
    const h = hashSecret("hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret("hello")).toBe(h);
    expect(hashSecret("world")).not.toBe(h);
  });

  it("compares hashes in constant time", () => {
    const h = hashSecret("x");
    expect(hashesEqual(h, hashSecret("x"))).toBe(true);
    expect(hashesEqual(h, hashSecret("y"))).toBe(false);
    expect(hashesEqual(h, "short")).toBe(false);
  });
});

describe("__Host-sm_as cookie", () => {
  it("serializes a Secure, HttpOnly, SameSite=Lax, Path=/ cookie", () => {
    const cookie = serializeSessionCookie("abc", 1800);
    expect(cookie).toContain(`${ONSITE_COOKIE_NAME}=abc`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=1800");
    // __Host- prefix forbids a Domain attribute.
    expect(cookie).not.toContain("Domain");
  });

  it("uses the __Host- prefixed name", () => {
    expect(ONSITE_COOKIE_NAME).toBe("__Host-sm_as");
  });

  it("parses a cookie header round-trip", () => {
    const header = serializeSessionCookie("val-123", 1800).split(";")[0];
    expect(parseCookies(header)[ONSITE_COOKIE_NAME]).toBe("val-123");
    expect(parseCookies(undefined)).toEqual({});
  });
});
