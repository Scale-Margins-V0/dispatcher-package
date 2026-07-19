import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OnsiteNotConfiguredError,
  decryptJson,
  encryptJson,
} from "./crypto.js";

const PRIOR = process.env.ONSITE_STATE_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.ONSITE_STATE_ENCRYPTION_KEY =
    "unit-test-onsite-key-abcdefghijklmnop";
});

afterEach(() => {
  if (PRIOR === undefined) delete process.env.ONSITE_STATE_ENCRYPTION_KEY;
  else process.env.ONSITE_STATE_ENCRYPTION_KEY = PRIOR;
});

describe("onsite crypto", () => {
  it("round-trips a JSON value", () => {
    const value = { headline: "Hi Ada", nested: { a: 1, b: ["x", "y"] } };
    const ct = encryptJson(value);
    expect(ct.startsWith("v1.")).toBe(true);
    expect(ct).not.toContain("Ada");
    expect(decryptJson(ct)).toEqual(value);
  });

  it("produces a fresh IV each call (ciphertext differs)", () => {
    expect(encryptJson({ a: 1 })).not.toBe(encryptJson({ a: 1 }));
  });

  it("fails to decrypt tampered ciphertext (GCM auth tag)", () => {
    const ct = encryptJson({ secret: "value" });
    const parts = ct.split(".");
    const flipped = Buffer.from(parts[3]!, "base64url");
    flipped[0] ^= 0x01;
    parts[3] = flipped.toString("base64url");
    expect(() => decryptJson(parts.join("."))).toThrow();
  });

  it("cannot decrypt with a different key", () => {
    const ct = encryptJson({ secret: "value" });
    process.env.ONSITE_STATE_ENCRYPTION_KEY =
      "a-totally-different-onsite-key-000000";
    expect(() => decryptJson(ct)).toThrow();
  });

  it("throws OnsiteNotConfiguredError when the key is unset", () => {
    delete process.env.ONSITE_STATE_ENCRYPTION_KEY;
    expect(() => encryptJson({ a: 1 })).toThrow(OnsiteNotConfiguredError);
  });

  it("rejects encryption keys shorter than 32 bytes", () => {
    process.env.ONSITE_STATE_ENCRYPTION_KEY = "too-short";
    expect(() => encryptJson({ a: 1 })).toThrow(OnsiteNotConfiguredError);
  });
});
