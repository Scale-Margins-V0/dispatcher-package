/**
 * At-rest encryption for onsite offer/render snapshots.
 *
 * AES-256-GCM (authenticated) keyed by SHA-256(ONSITE_STATE_ENCRYPTION_KEY) —
 * the same scheme the API-key store uses. Snapshots can hold personalized
 * strings (e.g. a first name in an offer headline), so they are never written
 * in the clear. Ciphertext format: `v1.<iv>.<tag>.<ct>` (base64url parts).
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/** Thrown when the encryption key is absent — onsite must fail closed. */
export class OnsiteNotConfiguredError extends Error {
  constructor(message = "ONSITE_STATE_ENCRYPTION_KEY is not set") {
    super(message);
    this.name = "OnsiteNotConfiguredError";
  }
}

function encryptionKey(): Buffer {
  const source = process.env.ONSITE_STATE_ENCRYPTION_KEY?.trim();
  if (!source || Buffer.byteLength(source, "utf8") < 32) {
    throw new OnsiteNotConfiguredError(
      "ONSITE_STATE_ENCRYPTION_KEY must contain at least 32 bytes"
    );
  }
  return createHash("sha256").update(source).digest();
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function decryptJson<T>(ciphertext: string): T {
  const [version, iv, tag, encrypted] = ciphertext.split(".");
  if (version !== "v1" || !iv || !tag || !encrypted) {
    throw new Error("Unsupported onsite ciphertext");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(iv, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8")) as T;
}
