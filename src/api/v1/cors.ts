/**
 * CORS for the external (Atlas) router. Either
 *
 *     dispatcher: { atlas_cors_origins: [https://atlas.scalemargin.com] }
 *     DISPATCHER_ATLAS_CORS_ORIGINS=https://atlas.scalemargin.com,https://staging.atlas.example
 *
 * Unset (the default) means no CORS headers are sent at all — a browser cannot
 * call the API, which is the safe posture for a server-to-server credential.
 *
 * A note worth keeping next to this code: anything that can read this API from
 * a browser must hold DISPATCHER_ATLAS_KEY, and that key grants full read
 * access to the dispatcher and cannot be revoked without a restart. Enable this
 * only for origins you control, and prefer calling the API from Atlas's backend
 * where the key never reaches a client device.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { resolveCorsOrigins, settingName } from "../../dispatcher-settings.js";

export const CORS_ORIGINS_ENV = "DISPATCHER_ATLAS_CORS_ORIGINS";

/**
 * Methods this router actually serves. Preflight is answered for these only,
 * so the write verbs have to be listed or the variable editor cannot save from
 * a browser — a preflight that omits PATCH fails before the request is sent.
 */
const ALLOWED_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
const ALLOWED_HEADERS = "authorization, content-type, accept";
const MAX_AGE_SECONDS = "600";

/** `https://host[:port]`, or "*", or null when unusable. */
function normalizeOrigin(raw: string): string | null {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) return null;
  if (value === "*") return "*";
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function allowedOrigins(): string[] {
  const configured = resolveCorsOrigins();
  if (!configured) return [];
  const out: string[] = [];
  for (const entry of configured.entries) {
    const origin = normalizeOrigin(entry);
    if (origin && !out.includes(origin)) out.push(origin);
  }
  return out;
}

export function isCorsEnabled(): boolean {
  return allowedOrigins().length > 0;
}

/** Boot-time advisory. Null when the configuration is unremarkable. */
export function corsWarning(): string | null {
  const configured = resolveCorsOrigins();
  // Unset, or an explicit empty list. Both mean "no CORS", which is the safe
  // default and needs no comment.
  if (!configured || configured.entries.length === 0) return null;

  const name = settingName("atlas_cors_origins", configured.source);
  const origins = allowedOrigins();
  if (origins.includes("*")) {
    return (
      `${name} is "*" — any website may call the Atlas API from a browser. ` +
      "The key it needs cannot be revoked without a restart; list explicit origins instead."
    );
  }
  const skipped = configured.entries.filter((entry) => normalizeOrigin(entry) === null);
  if (skipped.length > 0) {
    return `${name} has ${skipped.length} unparseable entr${skipped.length === 1 ? "y" : "ies"} (ignored) — use absolute origins like https://atlas.example.com`;
  }
  const insecure = origins.filter((origin) => origin.startsWith("http://") && !origin.startsWith("http://localhost"));
  if (insecure.length > 0) {
    return `${name} contains a plaintext origin (${insecure[0]}) — the API key would travel over http.`;
  }
  return null;
}

/**
 * Applies CORS headers and answers preflight.
 *
 * Preflight is handled HERE, before any authentication, because a browser never
 * attaches credentials to an `OPTIONS` request — gating it behind an API key
 * makes every cross-origin call fail with a misleading 401.
 */
export function corsMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origins = allowedOrigins();
    const requestOrigin = req.headers.origin;

    if (origins.length > 0 && requestOrigin) {
      const permitted = origins.includes("*") || origins.includes(requestOrigin);
      if (permitted) {
        res.setHeader("Access-Control-Allow-Origin", origins.includes("*") ? "*" : requestOrigin);
        // Responses differ by Origin, so caches must not share them.
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
        res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
        res.setHeader("Access-Control-Max-Age", MAX_AGE_SECONDS);
        // Deliberately NOT Access-Control-Allow-Credentials: auth is a bearer
        // header, not a cookie. Enabling it would widen the surface for nothing.
      }
    }

    // Answer preflight regardless of whether the origin was permitted. Without
    // the headers above the browser rejects it anyway, and a 204 keeps the
    // dispatcher's logs free of phantom "unauthorized" entries.
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  };
}
