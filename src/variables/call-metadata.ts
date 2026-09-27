/**
 * Call metadata: named schemas of keys an `api` variable can attach.
 *
 *   gold_metadata = { tenure, age, limit }
 *
 * An api variable that attaches `gold_metadata` may use, anywhere in its
 * request (URL, query values, headers, body):
 *
 *   {{tenure.k}}   the key's name — "tenure"
 *   {{tenure.v}}   the key's value — sent per dispatch as
 *                  `call_metadata: { id, values }` (see valuesForVariable)
 *
 * A schema is definitions only: a key, a sample `placeholder` shown in the UI
 * and never sent, and an optional `regex` a sent value must match. One schema
 * per variable, all of its keys usable; a schema or key a variable's request
 * still uses cannot be deleted or removed.
 */

import { z } from "zod";
import { getCallMetadataById, listCallMetadata } from "../db/repos/call-metadata.js";
import { listVariables } from "../db/repos/variables.js";
import type { CallMetadataRow, VariableRow } from "../db/schema/index.js";

/** `{{tenure.k}}` / `{{tenure.v}}` inside an api variable's request. */
export const METADATA_TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\.(k|v)\s*\}\}/g;

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** `{{field.x}}` already means "a lookup column" in a request — `field` cannot also be a key. */
const RESERVED_KEYS = new Set(["field"]);
export const MAX_METADATA_KEYS = 50;

const keySchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1, "Key is required")
      .max(64, "Key cannot exceed 64 characters")
      .regex(IDENTIFIER_RE, "Key must be letters, digits and _, not starting with a digit")
      .refine((k) => !RESERVED_KEYS.has(k), 'Key cannot be "field" — {{field.x}} already means a lookup column'),
    placeholder: z.string().max(500, "Placeholder cannot exceed 500 characters").optional(),
    regex: z.string().max(500, "Regex cannot exceed 500 characters").optional(),
  })
  .superRefine((k, ctx) => {
    if (!k.regex) return;
    let re: RegExp;
    try {
      re = new RegExp(k.regex);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["regex"],
        message: `Not a valid regular expression: ${error instanceof Error ? error.message : "parse error"}`,
      });
      return;
    }
    // The sample is what the UI shows as a valid value — it must pass its own rule.
    if (k.placeholder && !re.test(k.placeholder)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["placeholder"],
        message: "Placeholder does not match the key's regex",
      });
    }
  })
  .transform((k) => ({
    key: k.key,
    ...(k.placeholder ? { placeholder: k.placeholder } : {}),
    ...(k.regex ? { regex: k.regex } : {}),
  }));

const keysSchema = z
  .array(keySchema)
  .min(1, "Add at least one key")
  .max(MAX_METADATA_KEYS, `At most ${MAX_METADATA_KEYS} keys`)
  .superRefine((keys, ctx) => {
    const seen = new Set<string>();
    keys.forEach((k, i) => {
      if (seen.has(k.key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, "key"], message: `Key "${k.key}" is listed twice` });
      }
      seen.add(k.key);
    });
  });

const nameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(191, "Name cannot exceed 191 characters")
  .regex(IDENTIFIER_RE, "Name must be letters, digits and _, not starting with a digit");

export const ZCreateCallMetadataSchema = z.object({ name: nameSchema, keys: keysSchema });

export const ZUpdateCallMetadataSchema = z
  .object({ name: nameSchema.optional(), keys: keysSchema.optional() })
  .refine((p) => p.name !== undefined || p.keys !== undefined, "Send name, keys, or both");

/** The attachment stored on an api variable's config. */
export const ZVariableMetadataSchema = z
  .object({
    id: z.string().trim().min(1, "Pick a call metadata schema").max(36),
    /** Values are required at send time unless false: a missing one skips the call (fallback). */
    required: z.boolean().default(true),
  })
  .nullable();

export type VariableMetadata = { id: string; required: boolean };

type ApiRequestParts = {
  url?: string;
  query?: Array<{ key: string; value: string }>;
  headers?: Record<string, string>;
  body?: string;
  metadata?: VariableMetadata | null;
};

export type TokenUse = { key: string; kind: "k" | "v"; path: string };

/**
 * Every `{{key.k|v}}` in a request, with where it sits: `url`, `query.0.key`,
 * `query.0.value`, `headers.<name>` (name or value), `body`.
 */
export function metadataTokensIn(api: ApiRequestParts): TokenUse[] {
  const uses: TokenUse[] = [];
  const scan = (text: string | undefined, path: string) => {
    for (const m of (text ?? "").matchAll(METADATA_TOKEN_RE)) {
      uses.push({ key: m[1]!, kind: m[2] as "k" | "v", path });
    }
  };
  scan(api.url, "url");
  (api.query ?? []).forEach((q, i) => {
    scan(q.key, `query.${i}.key`);
    scan(q.value, `query.${i}.value`);
  });
  for (const [name, value] of Object.entries(api.headers ?? {})) {
    scan(name, `headers.${name}`);
    scan(value, `headers.${name}`);
  }
  scan(api.body, "body");
  return uses;
}

export type Detail = { path: string; message: string };

/**
 * Field-level problems with an api variable's metadata: the attached schema
 * must exist, and every `{{key.k|v}}` must be one of its keys. Paths are under
 * `definition.api`, matching the rest of the validation envelope.
 */
export async function checkVariableMetadata(api: ApiRequestParts): Promise<Detail[]> {
  const uses = metadataTokensIn(api);
  const base = "definition.api";
  if (!api.metadata) {
    return uses.map((u) => ({
      path: `${base}.${u.path}`,
      message: `{{${u.key}.k}} / {{${u.key}.v}} need a call metadata schema — pick one in "Call metadata"`,
    }));
  }
  const schema = await getCallMetadataById(api.metadata.id);
  if (!schema) {
    return [{ path: `${base}.metadata.id`, message: "That call metadata schema does not exist" }];
  }
  const keys = new Set(schema.keys.map((k) => k.key));
  return uses
    .filter((u) => !keys.has(u.key))
    .map((u) => ({
      path: `${base}.${u.path}`,
      message: `"${u.key}" is not a key of ${schema.name} (${[...keys].join(", ")})`,
    }));
}

/** The metadata attachment of a stored row, if it is a well-formed api variable one. */
export function metadataOf(row: Pick<VariableRow, "source" | "config">): VariableMetadata | null {
  if (row.source !== "api") return null;
  const raw = (row.config as { metadata?: unknown } | null)?.metadata as
    | { id?: unknown; required?: unknown }
    | null
    | undefined;
  return raw && typeof raw.id === "string"
    ? { id: raw.id, required: raw.required !== false }
    : null;
}

export type SchemaUsage = {
  variable: string;
  keys: string[];
  /** Keys whose value (`{{key.v}}`) this variable needs — empty when optional. */
  required_keys: string[];
};

/** Which api variables attach each schema, and which of its keys their requests use. */
export async function metadataUsage(): Promise<Map<string, SchemaUsage[]>> {
  const usage = new Map<string, SchemaUsage[]>();
  for (const row of await listVariables()) {
    const metadata = metadataOf(row);
    if (!metadata) continue;
    const uses = metadataTokensIn(row.config as ApiRequestParts);
    const keys = [...new Set(uses.map((u) => u.key))];
    const required_keys = metadata.required
      ? [...new Set(uses.filter((u) => u.kind === "v").map((u) => u.key))]
      : [];
    const list = usage.get(metadata.id) ?? [];
    list.push({ variable: row.name, keys, required_keys });
    usage.set(metadata.id, list);
  }
  return usage;
}

/** id → name, for showing a variable's attachment by name. */
export async function metadataNames(): Promise<Map<string, string>> {
  return new Map((await listCallMetadata()).map((m) => [m.id, m.name]));
}

export function serializeCallMetadata(row: CallMetadataRow, usedBy: SchemaUsage[] = []) {
  return {
    id: row.id,
    name: row.name,
    keys: row.keys,
    /** Api variables attaching this schema — delete is refused while any do. */
    used_by: usedBy.map((u) => u.variable),
    /** Keys a send must supply a value for — the platform blocks a campaign without them. */
    required_keys: [...new Set(usedBy.flatMap((u) => u.required_keys))].sort(),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    updated_by: row.updated_by,
  };
}

/** What a dispatch carries: values for ONE schema, `{ key: value }`. */
export type CallMetadataPayload = { id: string; values: Record<string, string> };

/** The payload's `call_metadata`, if well-formed — it arrives unvalidated. */
export function readCallMetadataPayload(raw: unknown): CallMetadataPayload | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { id, values } = raw as { id?: unknown; values?: unknown };
  if (typeof id !== "string" || !values || typeof values !== "object") return undefined;
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (typeof v === "string") clean[k] = v;
  return { id, values: clean };
}

/**
 * The `{{key.v}}` values one api variable gets for a send: the payload's values
 * when they are for the variable's schema, keeping only the schema's keys, non-
 * empty, and matching the key's regex. `missing` lists the keys the request
 * uses as `.v` that got no valid value — a required attachment skips the call.
 */
export function valuesForVariable(
  api: ApiRequestParts,
  schema: Pick<CallMetadataRow, "keys"> | undefined,
  payload: CallMetadataPayload | undefined
): { values: Record<string, string>; missing: string[]; invalid: string[] } {
  const values: Record<string, string> = {};
  const invalid: string[] = [];
  if (schema && payload && api.metadata && payload.id === api.metadata.id) {
    for (const k of schema.keys) {
      const v = payload.values[k.key];
      if (v === undefined || v === "") continue;
      let ok = true;
      try {
        ok = !k.regex || new RegExp(k.regex).test(v);
      } catch {
        ok = false;
      }
      if (ok) values[k.key] = v;
      else invalid.push(k.key);
    }
  }
  const used = new Set(metadataTokensIn(api).filter((u) => u.kind === "v").map((u) => u.key));
  return { values, missing: [...used].filter((k) => !(k in values)), invalid };
}
