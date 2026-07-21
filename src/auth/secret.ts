/**
 * BETTER_AUTH_SECRET resolution. Prefer the env var; otherwise generate a
 * random secret once and persist it to data/.better-auth-secret so sessions
 * survive restarts without any configuration. Production should set the env
 * var explicitly (we warn when we had to generate one).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { componentLogger } from "../logging/logger.js";

const log = componentLogger("auth");

const SECRET_FILE = process.env.DISPATCHER_AUTH_SECRET_FILE || "./data/.better-auth-secret";

let cached: string | null = null;

export function resolveAuthSecret(): string {
  if (cached) return cached;

  const fromEnv = process.env.BETTER_AUTH_SECRET?.trim();
  if (fromEnv) {
    cached = fromEnv;
    return cached;
  }

  // Under vitest, use a stable throwaway secret (no file writes).
  if (process.env.VITEST === "true") {
    cached = "vitest-insecure-static-better-auth-secret-0000000000";
    return cached;
  }

  try {
    if (existsSync(SECRET_FILE)) {
      const existing = readFileSync(SECRET_FILE, "utf8").trim();
      if (existing.length >= 32) {
        cached = existing;
        return cached;
      }
    }
    const generated = randomBytes(32).toString("hex");
    mkdirSync(dirname(SECRET_FILE), { recursive: true });
    writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
    try {
      chmodSync(SECRET_FILE, 0o600);
    } catch {
      /* best-effort on platforms without chmod */
    }
    log.warn(
      `BETTER_AUTH_SECRET was not set — generated one and stored it at ${SECRET_FILE}. ` +
        "Set BETTER_AUTH_SECRET explicitly in production so sessions stay valid across redeploys."
    );
    cached = generated;
    return cached;
  } catch (error) {
    // Filesystem unavailable — fall back to an in-memory secret (sessions reset on restart).
    log.warn(
      { err: error instanceof Error ? error : new Error(String(error)) },
      "Could not persist a generated BETTER_AUTH_SECRET; using an ephemeral one for this process"
    );
    cached = randomBytes(32).toString("hex");
    return cached;
  }
}

export function resetAuthSecretForTests(): void {
  cached = null;
}
