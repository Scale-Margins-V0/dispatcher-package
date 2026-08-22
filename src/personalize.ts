/**
 * Content Personalization
 *
 * Replaces ScaleMargin placeholders ({{first_name}}, {{company_name}}, etc.)
 * using the placeholder registry from `config/dispatch.yaml` (or built-in defaults).
 */

import type { PlaceholderEntry } from "./user-lookup/config.js";
import { getPlaceholderRegistry } from "./user-lookup/config.js";
import type { UserRecord } from "./user-lookup/types.js";

/** Optional dispatch row context for computed placeholders (e.g. `campaign_id` in `unsubscribe_url`). */
export type PersonalizeDispatchContext = {
  campaign_id: string;
  organization_id: string;
};

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
 * `UNSUBSCRIBE_URL_BASE` env is the dispatch host base (no path). Template
 * expressions `env.UNSUBSCRIBE_URL_BASE` / `env.PREFERENCES_URL_BASE` resolve to
 * `${UNSUBSCRIBE_URL_BASE}/api/unsubscribe` and `/api/preferences`. Optional
 * `UNSUBSCRIBE_LINK_URL` / `PREFERENCES_LINK_URL` override the full endpoint URLs.
 */
const LINK_PATH_BY_EXPR: Record<string, string> = {
  UNSUBSCRIBE_URL_BASE: "/api/unsubscribe",
  PREFERENCES_URL_BASE: "/api/preferences",
};

const LINK_URL_OVERRIDE_ENV: Record<string, string> = {
  UNSUBSCRIBE_URL_BASE: "UNSUBSCRIBE_LINK_URL",
  PREFERENCES_URL_BASE: "PREFERENCES_LINK_URL",
};

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveEnvVar(name: string): string {
  const overrideEnv = LINK_URL_OVERRIDE_ENV[name];
  if (overrideEnv) {
    const override = process.env[overrideEnv]?.trim();
    if (override) return override;
  }
  const pathSuffix = LINK_PATH_BY_EXPR[name];
  const hostBase = process.env.UNSUBSCRIBE_URL_BASE?.trim();
  if (pathSuffix && hostBase) {
    return trimTrailingSlashes(hostBase) + pathSuffix;
  }
  return process.env[name]?.trim() ?? "";
}

/**
 * Safe placeholder expression: string concat, `user_id`, `email`, `env.NAME`, field names, 'literals'.
 */
export function evaluateComputedExpression(
  expr: string,
  user: UserRecord,
  dispatchCtx?: PersonalizeDispatchContext
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
      out += resolveEnvVar(envM[1]!);
      continue;
    }
    if (p === "user_id") {
      out += user.user_id;
      continue;
    }
    if (p === "campaign_id") {
      if (!dispatchCtx) {
        throw new Error("campaign_id in expression requires dispatch context (internal error)");
      }
      out += dispatchCtx.campaign_id;
      continue;
    }
    if (p === "organization_id") {
      if (!dispatchCtx) {
        throw new Error("organization_id in expression requires dispatch context (internal error)");
      }
      out += dispatchCtx.organization_id;
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

/** Canned record for admin-side expression validation and previews. */
export const SAMPLE_PREVIEW_USER: UserRecord = {
  user_id: "usr_1024",
  email: "sample.user@example.com",
  fields: {
    first_name: "Ada",
    last_name: "Lovelace",
    company_name: "Acme Corp",
    email: "sample.user@example.com",
    phone: "15550100",
  },
};

const SAMPLE_PREVIEW_CTX: PersonalizeDispatchContext = {
  campaign_id: "cmp_sample",
  organization_id: "org_sample",
};

/**
 * Server-side validation for admin-supplied computed expressions. Runs the
 * real evaluator against the sample record so anything that passes here also
 * resolves at dispatch time.
 */
export function validateComputedExpression(
  expr: string
): { ok: true } | { ok: false; error: string } {
  if (!expr.trim()) return { ok: false, error: "expression is empty" };
  try {
    evaluateComputedExpression(expr, SAMPLE_PREVIEW_USER, SAMPLE_PREVIEW_CTX);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "invalid expression",
    };
  }
}

/** What a placeholder definition renders to for the sample record (sync sources only). */
export function renderPlaceholderPreview(def: PlaceholderEntry): string {
  return resolvePlaceholder(def, SAMPLE_PREVIEW_USER, SAMPLE_PREVIEW_CTX);
}

/** A resolved placeholder, plus whether the source produced it or the fallback did. */
export type ResolvedPlaceholder = { value: string; usedFallback: boolean };

/**
 * Resolve one placeholder for a user, reporting whether the fallback was used.
 *
 * Every branch already made that decision internally — this only surfaces it, so
 * a caller can count fallbacks without re-deriving the rules and drifting from
 * them. `resolvedValue` is the pre-computed value for async sources (query/api),
 * produced by src/variables/resolver.ts before the (sync) personalize pass;
 * sync sources ignore it.
 */
export function resolvePlaceholderWithMeta(
  def: PlaceholderEntry,
  user: UserRecord,
  dispatchCtx?: PersonalizeDispatchContext,
  resolvedValue?: string
): ResolvedPlaceholder {
  switch (def.source) {
    case "field": {
      const raw = user.fields[def.field];
      return raw !== undefined && raw.length > 0
        ? { value: raw, usedFallback: false }
        : { value: def.fallback ?? "", usedFallback: true };
    }
    case "computed": {
      try {
        const v = evaluateComputedExpression(def.expr, user, dispatchCtx);
        return v.length === 0 && def.fallback !== undefined
          ? { value: def.fallback, usedFallback: true }
          : { value: v, usedFallback: false };
      } catch {
        return { value: def.fallback ?? "", usedFallback: true };
      }
    }
    case "constant":
      return def.value.length > 0
        ? { value: def.value, usedFallback: false }
        : { value: def.fallback ?? def.value, usedFallback: true };
    case "query":
    case "api":
      return resolvedValue !== undefined && resolvedValue.length > 0
        ? { value: resolvedValue, usedFallback: false }
        : { value: def.fallback ?? "", usedFallback: true };
  }
}

function resolvePlaceholder(
  def: PlaceholderEntry,
  user: UserRecord,
  dispatchCtx?: PersonalizeDispatchContext,
  resolvedValue?: string
): string {
  return resolvePlaceholderWithMeta(def, user, dispatchCtx, resolvedValue).value;
}

/**
 * Matches exactly what personalize() substitutes — `{{name}}`, no inner spaces.
 * Deliberately stricter than the resolver's SQL/URL token regex, which tolerates
 * whitespace and dots; a template token that personalize would not replace must
 * not be counted as one that did.
 */
const CONTENT_TOKEN_RE = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;

/**
 * The registry entries a message actually references.
 *
 * This is the denominator for a fallback rate. Counting the whole registry would
 * inflate it, because a variable no template mentions "falls back" on every
 * send; a token with no registry entry is not a variable at all and is left
 * verbatim in the output, so it is excluded too.
 */
export function resolvableTokens(contents: Array<string | undefined>): string[] {
  const registry = getPlaceholderRegistry();
  const found = new Set<string>();
  for (const content of contents) {
    if (!content) continue;
    for (const match of content.matchAll(CONTENT_TOKEN_RE)) {
      const name = match[1]!;
      if (name in registry) found.add(name);
    }
  }
  return [...found];
}

/**
 * How many of `names` resolved to their fallback for this recipient.
 *
 * Uses the same resolver as personalize(), so the count can never disagree with
 * what was actually rendered.
 *
 * `asyncFallbacks` names the query/api variables the resolver already fell back
 * on. They have to be passed in: the resolver substitutes the fallback string
 * into `resolved` before personalize() ever sees it, so from here a fallback and
 * a real value are the same string.
 */
export function countFallbacks(
  names: string[],
  user: UserRecord,
  dispatchCtx?: PersonalizeDispatchContext,
  resolved?: Record<string, string>,
  asyncFallbacks?: ReadonlySet<string>
): number {
  if (names.length === 0) return 0;
  const registry = getPlaceholderRegistry();
  let count = 0;
  for (const name of names) {
    const def = registry[name];
    if (!def) continue;
    if (
      asyncFallbacks?.has(name) ||
      resolvePlaceholderWithMeta(def, user, dispatchCtx, resolved?.[name]).usedFallback
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * Personalize content for a specific user.
 * Replaces all {{placeholder}} patterns with user data. `resolved` supplies the
 * pre-computed values for async (query/api) placeholders, keyed by name.
 */
export function personalize(
  content: string,
  user: UserRecord,
  dispatchCtx?: PersonalizeDispatchContext,
  resolved?: Record<string, string>
): string {
  let result = content;
  const registry = getPlaceholderRegistry();
  for (const [name, def] of Object.entries(registry)) {
    const value = resolvePlaceholder(def, user, dispatchCtx, resolved?.[name]);
    result = result.replaceAll(
      new RegExp(`\\{\\{${escapeReg(name)}\\}\\}`, "g"),
      value
    );
  }
  return result;
}
