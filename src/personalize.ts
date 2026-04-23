/**
 * Content Personalization
 *
 * Replaces ScaleMargin placeholders ({{first_name}}, {{company_name}}, etc.)
 * using the placeholder registry from `config/dispatch.yaml` (or built-in defaults).
 */

import type { PlaceholderEntry } from "./user-lookup/config.js";
import { getPlaceholderRegistry } from "./user-lookup/config.js";
import type { UserRecord } from "./user-lookup/types.js";

/** Block obvious code-injection tokens in YAML `computed` expressions (not a full sandbox). */
const REJECT_SEGMENT = /eval|Function|import|require|__proto__|prototype/i;

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitTopLevelPlus(expr: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!;
    if (c === "'" && (i === 0 || expr[i - 1] !== "\\")) {
      inQuote = !inQuote;
    } else if (c === "+" && !inQuote) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur.trim());
  return parts.filter((p) => p.length > 0);
}

function unquoteString(s: string): string | null {
  if (s.length < 2 || !s.startsWith("'") || !s.endsWith("'")) return null;
  const inner = s.slice(1, -1);
  return inner.replace(/\\(.)/g, "$1");
}

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const ENV_KEY = /^env\.([A-Za-z][A-Za-z0-9_]*)$/;

/**
 * Safe placeholder expression: string concat, `user_id`, `email`, `env.NAME`, field names, 'literals'.
 */
export function evaluateComputedExpression(
  expr: string,
  user: UserRecord
): string {
  if (REJECT_SEGMENT.test(expr)) {
    throw new Error("unsupported expression");
  }
  const parts = splitTopLevelPlus(expr);
  let out = "";
  for (const part of parts) {
    const p = part.trim();
    const envM = p.match(ENV_KEY);
    if (envM) {
      out += process.env[envM[1]!] ?? "";
      continue;
    }
    if (p === "user_id") {
      out += user.user_id;
      continue;
    }
    if (p === "email") {
      out += user.email;
      continue;
    }
    const quoted = unquoteString(p);
    if (quoted !== null) {
      if (REJECT_SEGMENT.test(quoted)) {
        throw new Error("unsupported literal");
      }
      out += quoted;
      continue;
    }
    if (IDENT.test(p)) {
      const v = user.fields[p];
      out += v ?? "";
      continue;
    }
    throw new Error(`unsupported expression segment: ${JSON.stringify(p)}`);
  }
  return out;
}

function resolvePlaceholder(def: PlaceholderEntry, user: UserRecord): string {
  if (def.source === "field") {
    const raw = user.fields[def.field];
    if (raw !== undefined && raw.length > 0) {
      return raw;
    }
    return def.fallback ?? "";
  }
  try {
    const v = evaluateComputedExpression(def.expr, user);
    if (v.length === 0 && def.fallback !== undefined) {
      return def.fallback;
    }
    return v;
  } catch {
    return def.fallback ?? "";
  }
}

/**
 * Personalize content for a specific user.
 * Replaces all {{placeholder}} patterns with user data.
 */
export function personalize(content: string, user: UserRecord): string {
  let result = content;
  const registry = getPlaceholderRegistry();
  for (const [name, def] of Object.entries(registry)) {
    const value = resolvePlaceholder(def, user);
    result = result.replaceAll(
      new RegExp(`\\{\\{${escapeReg(name)}\\}\\}`, "g"),
      value
    );
  }
  return result;
}
