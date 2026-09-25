/**
 * The shape of an `api` variable's JSON response, and reading values out of it.
 *
 * A template reaches into the response with a dotted path after the variable
 * name — `{{user_info.info.address.pincode}}`, `{{user_info.orders.0.id}}`.
 * The operator describes the shape once, by listing the paths or by pasting a
 * sample response; that list is what the platform offers for autocomplete. It
 * is not a gate: a path a template uses is resolved whether or not it was
 * declared, because the response decides what exists, not the declaration.
 *
 * A pasted sample is reduced to paths, types and a short example per path and
 * then discarded — a real response can carry a real person's data.
 *
 * Only single values are placeholders. A token lands inside a sentence, so it
 * must end at a string, number or boolean — never an object or a list, which
 * would print as `{"city":"Pune"}` in someone's inbox. Objects and arrays are
 * walked through (`info.address.pincode`, `orders.0.id`) but never offered,
 * and at send time a path that turns out to hold one renders the fallback.
 */

/** What a placeholder may resolve to. `null` = the sample had null there; the type is unknown. */
export const RESPONSE_FIELD_TYPES = ["string", "number", "boolean", "null"] as const;
export type ResponseFieldType = (typeof RESPONSE_FIELD_TYPES)[number];

export type ResponseField = {
  /** Dotted path from the response root: `info.address.pincode`, `orders.0.id`. */
  path: string;
  type: ResponseFieldType;
  /** A short example, when the path came from a pasted sample. */
  example?: string;
};

/** A key a template can address: an identifier, or an array index. */
export const PATH_SEGMENT_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*|\d+)$/;
export const MAX_RESPONSE_FIELDS = 200;
export const MAX_PATH_DEPTH = 8;
const MAX_EXAMPLE_CHARS = 120;

export function isValidResponsePath(path: string): boolean {
  const segments = path.split(".");
  return (
    segments.length > 0 &&
    segments.length <= MAX_PATH_DEPTH &&
    segments.every((s) => PATH_SEGMENT_RE.test(s)) &&
    // A path cannot start with an index: `{{user_info.0}}` is ambiguous with a
    // variable whose response is an array, and nothing needs it.
    !/^\d+$/.test(segments[0]!)
  );
}

/** The placeholder type of a single value; null for an object or array, which is never one. */
function leafTypeOf(value: unknown): ResponseFieldType | null {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return null;
  }
}

function exampleOf(value: unknown): string | undefined {
  if (value === null || typeof value === "object") return undefined;
  const s = String(value);
  return s.length > MAX_EXAMPLE_CHARS ? `${s.slice(0, MAX_EXAMPLE_CHARS)}…` : s;
}

export type DerivedSchema = {
  fields: ResponseField[];
  /** Keys no template could address (spaces, dashes, dots…), by their parent path. */
  skipped: string[];
  /** True when the field cap or the depth cap cut the walk short. */
  truncated: boolean;
};

/**
 * Every single-value path in a sample response. Objects and arrays are walked,
 * not listed; an array is described by its first element, as index `0` —
 * enough to show the shape without enumerating a thousand identical rows.
 */
export function deriveResponseSchema(sample: unknown): DerivedSchema {
  const fields: ResponseField[] = [];
  const skipped: string[] = [];
  let truncated = false;

  const walk = (value: unknown, path: string[]): void => {
    if (fields.length >= MAX_RESPONSE_FIELDS) {
      truncated = true;
      return;
    }
    const type = leafTypeOf(value);
    if (path.length > 0 && type !== null) {
      const example = exampleOf(value);
      fields.push({
        path: path.join("."),
        type,
        ...(example !== undefined ? { example } : {}),
      });
    }
    if (path.length >= MAX_PATH_DEPTH) {
      if (value !== null && typeof value === "object") truncated = true;
      return;
    }
    if (Array.isArray(value)) {
      if (path.length > 0 && value.length > 0) walk(value[0], [...path, "0"]);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (!PATH_SEGMENT_RE.test(key) || /^\d+$/.test(key)) {
          skipped.push(path.length ? `${path.join(".")}.${key}` : key);
          continue;
        }
        walk(child, [...path, key]);
      }
    }
  };

  walk(sample, []);
  return { fields, skipped, truncated };
}

/** The value at a dotted path, or undefined when any step is missing. */
export function valueAtPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = Array.isArray(cur) ? cur[Number(seg)] : (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * How a value lands in a message. Only a single value renders; null, missing,
 * an object or an array are "no value" and the variable's fallback is used —
 * a placeholder never prints JSON into a sentence.
 */
export function renderValue(value: unknown): string | null {
  if (value === null || value === undefined || typeof value === "object") return null;
  return String(value);
}

/** Drop anything that is not a single-value type — e.g. rows stored before objects were excluded. */
export function primitiveFieldsOnly(fields: ResponseField[] | undefined): ResponseField[] {
  const allowed = new Set<string>(RESPONSE_FIELD_TYPES);
  return (fields ?? []).filter((f) => allowed.has(f.type));
}

/**
 * Merge a sample-derived schema with explicitly listed fields. An explicit
 * entry wins on the same path — the operator said what it is.
 */
export function mergeResponseSchema(
  derived: ResponseField[],
  explicit: ResponseField[] | undefined
): ResponseField[] {
  const byPath = new Map<string, ResponseField>();
  for (const f of derived) byPath.set(f.path, f);
  for (const f of explicit ?? []) byPath.set(f.path, { ...byPath.get(f.path), ...f });
  return [...byPath.values()].slice(0, MAX_RESPONSE_FIELDS);
}

/**
 * Every token an api variable offers a template. `{{name}}` itself only when a
 * default value path picks one value — with none it would be the whole
 * response, an object. Then `name.<path>` for each single-value path.
 */
export function apiPlaceholders(
  name: string,
  schema: ResponseField[] | undefined,
  jsonPath = ""
): string[] {
  const own = jsonPath.trim() ? [name] : [];
  return [...own, ...primitiveFieldsOnly(schema).map((f) => `${name}.${f.path}`)];
}
