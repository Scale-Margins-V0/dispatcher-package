/**
 * Minimal cookie read/write helpers for the __Host-sm_as session cookie. Kept
 * dependency-free (no cookie-parser) since only one cookie is involved.
 *
 * The `__Host-` prefix requires the cookie to be Secure, Path=/, and carry no
 * Domain — so it is always emitted Secure regardless of the request scheme.
 */

import type { Request } from "express";
import {
  ONSITE_COOKIE_NAME,
  ONSITE_COOKIE_PATH,
  SESSION_IDLE_SECONDS,
} from "./config.js";

export function parseCookies(
  header: string | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function readSessionCookie(req: Request): string | null {
  return parseCookies(req.headers.cookie)[ONSITE_COOKIE_NAME] ?? null;
}

/**
 * Serialize the session Set-Cookie. Max-Age is the sliding idle window (30m);
 * re-emitting it on each access is how idle timeout is enforced browser-side,
 * while the server independently enforces the 24h absolute ceiling.
 */
export function serializeSessionCookie(
  value: string,
  maxAgeSeconds: number = SESSION_IDLE_SECONDS
): string {
  return [
    `${ONSITE_COOKIE_NAME}=${encodeURIComponent(value)}`,
    `Path=${ONSITE_COOKIE_PATH}`,
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
  ].join("; ");
}

/** Expire the session cookie. */
export function clearSessionCookie(): string {
  return serializeSessionCookie("", 0);
}
