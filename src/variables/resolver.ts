/**
 * Async resolution for dynamic variables (source=query|api). Runs once per
 * dispatch, before the sync personalize() pass. Values are resolved PER
 * RECIPIENT but cached by their effective inputs, so a definition that doesn't
 * reference user tokens executes only once for the whole batch. Failures fall
 * back (never throw into the dispatch) and are logged as warnings so they
 * surface in the Logs page.
 */

import { componentLogger } from "../logging/logger.js";
import { renderPlaceholderPreview, SAMPLE_PREVIEW_USER } from "../personalize.js";
import type { PlaceholderEntry } from "../user-lookup/config.js";
import { getPlaceholderRegistry } from "../user-lookup/config.js";
import { getLookupAdapter } from "../user-lookup/index.js";
import type { UserRecord } from "../user-lookup/types.js";
import { deriveResponseSchema, renderValue, valueAtPath, type ResponseField } from "./api-response.js";
import { listCallMetadata } from "../db/repos/call-metadata.js";
import type { CallMetadataRow } from "../db/schema/index.js";
import { valuesForVariable, type CallMetadataPayload } from "./call-metadata.js";
import { recordMetric, type MetricScope } from "../metrics/collector.js";

const log = componentLogger("variables.resolver");

const CONCURRENCY = 8;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

export type ResolveContext = {
  campaign_id: string;
  organization_id: string;
  /** The dispatch's `call_metadata` — values for one schema. */
  call_metadata?: CallMetadataPayload;
  /** `{{key.v}}` for the variable being resolved — set per variable, never by callers. */
  meta_values?: Record<string, string>;
  /** Where api/query timings are recorded (src/metrics/collector.ts). Absent = not recorded. */
  metrics?: MetricScope;
};

/** An abort or our own race timer — reported apart from other failures. */
function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /timed? ?out/i.test(error.message));
}

const SAMPLE_CTX: ResolveContext = { campaign_id: "cmp_sample", organization_id: "org_sample" };

type DynamicEntry = Extract<PlaceholderEntry, { source: "query" | "api" }>;

const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;

function tokenValue(token: string, user: UserRecord, ctx: ResolveContext): string {
  if (token === "user_id") return user.user_id;
  if (token === "email") return user.email;
  if (token === "campaign_id") return ctx.campaign_id;
  if (token === "organization_id") return ctx.organization_id;
  if (token.startsWith("field.")) return user.fields[token.slice(6)] ?? "";
  // Call metadata (call-metadata.ts): `{{tenure.k}}` is the key's name,
  // `{{tenure.v}}` the value this send carries for it — never the UI's sample.
  const meta = /^([a-zA-Z_][a-zA-Z0-9_]*)\.(k|v)$/.exec(token);
  if (meta) return meta[2] === "k" ? meta[1]! : (ctx.meta_values?.[meta[1]!] ?? "");
  return "";
}

type Encoding = "raw" | "url" | "json";

/**
 * `json` escapes for the inside of a JSON string, so a recipient named
 * `O"Brien` cannot break — or inject into — a JSON request body.
 */
function interpolate(
  template: string,
  user: UserRecord,
  ctx: ResolveContext,
  encoding: Encoding | boolean
): string {
  const mode: Encoding = encoding === true ? "url" : encoding === false ? "raw" : encoding;
  return template.replace(TOKEN_RE, (_m, token: string) => {
    const v = tokenValue(token, user, ctx);
    if (mode === "url") return encodeURIComponent(v);
    if (mode === "json") return JSON.stringify(v).slice(1, -1);
    return v;
  });
}

type ApiEntry = Extract<DynamicEntry, { source: "api" }>;

/**
 * The URL with query rows appended. Names and values both take {{tokens}} —
 * `{{tenure.k}}` as a parameter name is the point of `.k` — and are encoded by
 * URLSearchParams. A name that interpolates to "" is dropped, not sent as `=`.
 */
function buildApiUrl(entry: ApiEntry, user: UserRecord, ctx: ResolveContext): string {
  const base = interpolate(entry.api.url, user, ctx, "url");
  if (!/^https?:\/\//i.test(base)) {
    throw new Error("API url must start with http(s)://");
  }
  const rows = entry.api.query ?? [];
  if (rows.length === 0) return base;
  const url = new URL(base);
  for (const { key, value } of rows) {
    const name = interpolate(key, user, ctx, "raw");
    if (name) url.searchParams.append(name, interpolate(value, user, ctx, "raw"));
  }
  return url.toString();
}

function isJsonContentType(headers: Record<string, string>): boolean {
  const ct = Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type")?.[1];
  return ct === undefined || /json/i.test(ct);
}

/** GET never sends a body, whatever is stored. */
function buildApiBody(
  entry: ApiEntry,
  headers: Record<string, string>,
  user: UserRecord,
  ctx: ResolveContext
): string | undefined {
  if (!entry.api.body || entry.api.method === "GET") return undefined;
  return interpolate(entry.api.body, user, ctx, isJsonContentType(headers) ? "json" : "raw");
}

function sqlBindings(user: UserRecord, ctx: ResolveContext): Record<string, string> {
  return {
    user_id: user.user_id,
    email: user.email,
    campaign_id: ctx.campaign_id,
    organization_id: ctx.organization_id,
  };
}

/**
 * What `{{name}}` renders: the single value at the default path. An object or
 * array there — including the whole body when no path is set — is not a value
 * a sentence can hold, so the fallback is used (see api-response.ts).
 */
function extractJsonPath(obj: unknown, path: string): string | null {
  return renderValue(path.trim() ? valueAtPath(obj, path) : obj);
}

function raceTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/** Raw HTTP result — only throws on url/network/timeout, not on a non-2xx status. */
export type ApiFetchResult = {
  ok: boolean;
  status: number;
  time_ms: number;
  size: number;
  body: string;
};

async function fetchApi(
  entry: ApiEntry,
  user: UserRecord,
  ctx: ResolveContext
): Promise<ApiFetchResult> {
  const url = buildApiUrl(entry, user, ctx);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(entry.api.headers ?? {})) {
    const name = interpolate(k, user, ctx, false);
    if (name) headers[name] = interpolate(v, user, ctx, false);
  }
  const body = buildApiBody(entry, headers, user, ctx);
  if (body && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
    headers["content-type"] = "application/json";
  }
  const timeout = Math.min(entry.api.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: entry.api.method,
      headers,
      ...(body ? { body } : {}),
      signal: controller.signal,
    });
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new Error(`API response exceeded ${MAX_RESPONSE_BYTES} bytes`);
    }
    return {
      ok: res.ok,
      status: res.status,
      time_ms: Math.round(performance.now() - started),
      size: text.length,
      body: text,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function executeApi(
  entry: ApiEntry,
  user: UserRecord,
  ctx: ResolveContext
): Promise<unknown> {
  const res = await fetchApi(entry, user, ctx);
  if (!res.ok) throw new Error(`API responded ${res.status}`);
  try {
    return JSON.parse(res.body);
  } catch {
    throw new Error("API response was not valid JSON");
  }
}

/**
 * One execution's values, keyed by the token they fill: `""` for `{{name}}`
 * itself, and each requested path for `{{name.<path>}}`. Only requested paths
 * are kept, so a large response costs memory once, not once per recipient.
 */
type Extracted = Map<string, string | null>;

async function executeVariable(
  entry: DynamicEntry,
  user: UserRecord,
  ctx: ResolveContext,
  paths: ReadonlySet<string>
): Promise<Extracted> {
  if (entry.source === "query") {
    const adapter = getLookupAdapter();
    if (typeof adapter.runScalarQuery !== "function") {
      throw new Error(
        "SQL variables require a SQL lookup backend (mysql/postgres/sqlite)"
      );
    }
    const v = await raceTimeout(
      adapter.runScalarQuery(entry.sql, sqlBindings(user, ctx)),
      DEFAULT_TIMEOUT_MS,
      "SQL variable"
    );
    return new Map([["", v]]);
  }
  const json = await executeApi(entry, user, ctx);
  const out: Extracted = new Map([["", extractJsonPath(json, entry.api.json_path)]]);
  for (const path of paths) out.set(path, renderValue(valueAtPath(json, path)));
  return out;
}

/** Cache key = source + the effective inputs, so identical executions dedupe. */
function cacheKey(entry: DynamicEntry, user: UserRecord, ctx: ResolveContext): string {
  if (entry.source === "query") {
    const tokens = [...entry.sql.matchAll(TOKEN_RE)].map((m) => m[1]!);
    const b = sqlBindings(user, ctx);
    return `q ${entry.sql} ${tokens.map((t) => b[t] ?? "").join(" ")}`;
  }
  const headers = Object.entries(entry.api.headers ?? {})
    .map(([k, v]) => `${interpolate(k, user, ctx, false)}=${interpolate(v, user, ctx, false)}`)
    .join(" ");
  const url = buildApiUrl(entry, user, ctx);
  const body = buildApiBody(entry, entry.api.headers ?? {}, user, ctx) ?? "";
  return `a ${entry.api.method} ${url} ${headers} ${body}`;
}

async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * One recipient's async resolutions.
 *
 * `fallbacks` has to be reported separately because `values` already has the
 * fallback substituted in — by the time personalize() sees the string there is
 * no way to tell it apart from a real one, and a fallback that happens to equal
 * the real value would be indistinguishable either way.
 */
export type DynamicResolution = {
  /** Token → value: `name`, and `name.<path>` for api variables. */
  values: Record<string, string>;
  /** Tokens whose source yielded nothing, or threw, and fell back. */
  fallbacks: string[];
};

/** `{{name.a.b}}` in message content — the dotted half of what personalize() fills. */
const NESTED_TOKEN_RE = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)((?:\.[A-Za-z0-9_]+)+)\}\}/g;

/**
 * The response paths each api variable must yield: every declared path plus
 * every path the message actually uses. Declared paths let a preview show them;
 * used paths are what makes an undeclared one still resolve.
 */
function pathsToExtract(
  dynamic: Array<[string, DynamicEntry]>,
  contents: Array<string | undefined>
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [name, entry] of dynamic) {
    if (entry.source !== "api") continue;
    out.set(name, new Set((entry.api.response_schema ?? []).map((f) => f.path)));
  }
  for (const content of contents) {
    if (!content) continue;
    for (const m of content.matchAll(NESTED_TOKEN_RE)) {
      out.get(m[1]!)?.add(m[2]!.slice(1));
    }
  }
  return out;
}

/**
 * Per api variable attaching call metadata: the context carrying its `{{key.v}}`
 * values, or `null` when a required value is missing — the call is skipped and
 * the variable falls back rather than hit the API with a blank.
 */
async function metadataContexts(
  dynamic: Array<[string, DynamicEntry]>,
  ctx: ResolveContext
): Promise<Map<string, ResolveContext | null>> {
  const out = new Map<string, ResolveContext | null>();
  const attached = dynamic.filter(
    (d): d is [string, ApiEntry] => d[1].source === "api" && Boolean(d[1].api.metadata)
  );
  if (attached.length === 0) return out;
  let schemas = new Map<string, CallMetadataRow>();
  try {
    schemas = new Map((await listCallMetadata()).map((row) => [row.id, row]));
  } catch (error) {
    log.warn({ err: error instanceof Error ? error : new Error(String(error)) }, "Could not load call metadata schemas");
  }
  for (const [name, entry] of attached) {
    const { values, missing, invalid } = valuesForVariable(
      entry.api,
      schemas.get(entry.api.metadata!.id),
      ctx.call_metadata
    );
    // Key names only — values can be customer data.
    if (invalid.length > 0) {
      log.warn({ variable: name, keys: invalid }, "Call metadata values do not match their regex — ignored");
    }
    if (missing.length > 0 && entry.api.metadata!.required) {
      log.warn({ variable: name, keys: missing }, "Required call metadata values missing — skipping the API call, using fallback");
      out.set(name, null);
      continue;
    }
    out.set(name, { ...ctx, meta_values: values });
  }
  return out;
}

/**
 * Resolve every query/api variable for the recipient set. Returns
 * user_id → { values, fallbacks }. Sync sources are untouched here.
 *
 * `contents` is the message text (subject, bodies, WhatsApp params) — scanned
 * for `{{name.path}}` so a path a template uses resolves even if undeclared.
 */
export async function resolveDynamicValues(
  users: UserRecord[],
  ctx: ResolveContext,
  contents: Array<string | undefined> = []
): Promise<Map<string, DynamicResolution>> {
  const result = new Map<string, DynamicResolution>();
  const registry = getPlaceholderRegistry();
  const dynamic = Object.entries(registry).filter(
    ([, e]) => e.source === "query" || e.source === "api"
  ) as Array<[string, DynamicEntry]>;
  if (dynamic.length === 0 || users.length === 0) return result;
  const paths = pathsToExtract(dynamic, contents);
  const NO_PATHS: ReadonlySet<string> = new Set();
  const metaCtx = await metadataContexts(dynamic, ctx);

  type Plan = { userId: string; name: string; entry: DynamicEntry; key: string };
  const plans: Plan[] = [];
  const jobByKey = new Map<
    string,
    { name: string; entry: DynamicEntry; user: UserRecord; ctx: ResolveContext }
  >();
  for (const user of users) {
    for (const [name, entry] of dynamic) {
      const entryCtx = metaCtx.has(name) ? metaCtx.get(name)! : ctx;
      if (entryCtx === null) {
        // No job: the missing outcome below is the fallback.
        plans.push({ userId: user.user_id, name, entry, key: `${name}\u0000skipped` });
        continue;
      }
      // The variable name is part of the key: two variables calling the same
      // URL still need their own paths extracted.
      const key = `${name}\u0000${cacheKey(entry, user, entryCtx)}`;
      plans.push({ userId: user.user_id, name, entry, key });
      if (!jobByKey.has(key)) jobByKey.set(key, { name, entry, user, ctx: entryCtx });
    }
  }

  const outcomes = new Map<string, Extracted | null>();
  await mapLimit([...jobByKey.keys()], CONCURRENCY, async (key) => {
    const { name, entry, user, ctx: entryCtx } = jobByKey.get(key)!;
    const kind = entry.source === "api" ? "api_call" : "query_var";
    const started = performance.now();
    try {
      outcomes.set(key, await executeVariable(entry, user, entryCtx, paths.get(name) ?? NO_PATHS));
      if (ctx.metrics) recordMetric(ctx.metrics, kind, name, { ok: 1, ms: performance.now() - started });
    } catch (error) {
      outcomes.set(key, null);
      if (ctx.metrics) {
        recordMetric(ctx.metrics, kind, name, {
          ...(isTimeout(error) ? { timeout: 1 } : { failed: 1 }),
          ms: performance.now() - started,
        });
      }
      log.warn(
        { err: error instanceof Error ? error : new Error(String(error)), source: entry.source },
        `Dynamic variable resolution failed (${entry.source}) — using fallback`
      );
    }
  });

  // Per variable: recipients served, how many fell back, how many were skipped.
  const served = new Map<string, { kind: "api_call" | "query_var"; items: number; fallback: number; skipped: number }>();
  for (const plan of plans) {
    const tally = served.get(plan.name) ?? {
      kind: plan.entry.source === "api" ? "api_call" : "query_var",
      items: 0,
      fallback: 0,
      skipped: 0,
    };
    served.set(plan.name, tally);
    tally.items += 1;
    if (plan.key.endsWith("\u0000skipped")) tally.skipped += 1;
    const fallbacksBefore = result.get(plan.userId)?.fallbacks.length ?? 0;
    const extracted = outcomes.get(plan.key) ?? null;
    const bucket = result.get(plan.userId) ?? { values: {}, fallbacks: [] };
    const fallback = plan.entry.fallback ?? "";
    const tokens: Array<[string, string]> = [
      [plan.name, ""],
      ...[...(paths.get(plan.name) ?? NO_PATHS)].map((p): [string, string] => [`${plan.name}.${p}`, p]),
    ];
    for (const [token, path] of tokens) {
      const raw = extracted?.get(path) ?? null;
      const resolved = raw !== null && raw.length > 0;
      bucket.values[token] = resolved ? raw : fallback;
      if (!resolved) bucket.fallbacks.push(token);
    }
    result.set(plan.userId, bucket);
    if (bucket.fallbacks.length > fallbacksBefore) tally.fallback += 1;
  }
  if (ctx.metrics) {
    for (const [name, t] of served) {
      recordMetric(ctx.metrics, t.kind, name, { count: 0, items: t.items, fallback: t.fallback, skipped: t.skipped });
    }
  }
  return result;
}

export type VariableTestResult = {
  ok: boolean;
  value?: string;
  error?: string;
  /** Present for source=api — the raw HTTP exchange, for the request builder. */
  response?: ApiFetchResult;
  /** source=api with a JSON body: every addressable path, ready to save as the schema. */
  schema?: ResponseField[];
};

/**
 * Live single-definition test for the admin editor. Runs query/api for real
 * against the sample user. For `api` it returns the full response (status,
 * timing, size, body) even on a non-2xx, so the UI can show it like a REST
 * client rather than just an error string.
 */
export async function testVariableDefinition(entry: PlaceholderEntry): Promise<VariableTestResult> {
  try {
    if (entry.source === "api") {
      const res = await fetchApi(entry, SAMPLE_PREVIEW_USER, SAMPLE_CTX);
      let value: string | null = null;
      let error: string | undefined;
      let schema: ResponseField[] | undefined;
      if (!res.ok) {
        error = `API responded ${res.status}`;
      } else {
        try {
          const json = JSON.parse(res.body);
          value = extractJsonPath(json, entry.api.json_path);
          schema = deriveResponseSchema(json).fields;
        } catch {
          error = "Response was not valid JSON";
        }
      }
      return {
        ok: res.ok && !error,
        value: value !== null && value.length > 0 ? value : (entry.fallback ?? ""),
        ...(error ? { error } : {}),
        response: res,
        ...(schema ? { schema } : {}),
      };
    }
    if (entry.source === "query") {
      const raw = (await executeVariable(entry, SAMPLE_PREVIEW_USER, SAMPLE_CTX, new Set())).get("") ?? null;
      return { ok: true, value: raw !== null && raw.length > 0 ? raw : (entry.fallback ?? "") };
    }
    return { ok: true, value: renderPlaceholderPreview(entry) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "resolution failed" };
  }
}
