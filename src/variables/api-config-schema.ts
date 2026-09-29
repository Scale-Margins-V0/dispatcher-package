/**
 * Input rules for an `api` variable's request and response shape, shared by
 * the data-plane and admin write surfaces so both accept exactly the same thing.
 *
 * `response_sample` is write-only: a pasted response is reduced to paths
 * (api-response.ts) and dropped here, before anything is stored. A real
 * response can carry a real person's data, and the paths are all we need.
 */

import { z } from "zod";
import {
  deriveResponseSchema,
  isValidResponsePath,
  MAX_PATH_DEPTH,
  MAX_RESPONSE_FIELDS,
  mergeResponseSchema,
  RESPONSE_FIELD_TYPES,
  type ResponseField,
} from "./api-response.js";
import { ZVariableMetadataSchema } from "./call-metadata.js";

const MAX_QUERY_ROWS = 50;
/** Providers a response can be saved against — the message id it is keyed on. */
export const SAVE_RESPONSE_PROVIDERS = ["freshchat"] as const;
export const MAX_SAVED_PATHS = 5;
const MAX_SAMPLE_BYTES = 256 * 1024;

export const apiExtrasShape = {
  /** Appended to the URL. Values take {{tokens}}; both sides are URL-encoded. */
  query: z
    .array(
      z.object({
        key: z.string().trim().min(1, "Query parameter name is required").max(200),
        value: z.string().max(2000, "Query parameter value cannot exceed 2000 characters"),
      })
    )
    .max(MAX_QUERY_ROWS, `At most ${MAX_QUERY_ROWS} query parameters`)
    .optional(),
  /** The paths a template can use: `info.address.pincode`, `orders.0.id`. */
  response_schema: z
    .array(
      z.object({
        path: z
          .string()
          .trim()
          .refine(
            isValidResponsePath,
            `Path must be dot-separated keys (letters, digits, _) or array indexes, at most ${MAX_PATH_DEPTH} deep, e.g. info.address.pincode`
          ),
        type: z.enum(RESPONSE_FIELD_TYPES),
        example: z.string().max(200).optional(),
      })
    )
    .max(MAX_RESPONSE_FIELDS, `At most ${MAX_RESPONSE_FIELDS} response fields`)
    .optional(),
  /** One call metadata schema; its keys become {{key.k}} / {{key.v}} in the request. */
  metadata: ZVariableMetadataSchema.optional(),
  /**
   * Save these response values against the message they were sent with, when
   * `provider` accepts it (table api_response_refs). `null` turns it off.
   */
  save_response: z
    .object({
      provider: z.enum(SAVE_RESPONSE_PROVIDERS, {
        errorMap: () => ({ message: `Responses can only be saved for: ${SAVE_RESPONSE_PROVIDERS.join(", ")}` }),
      }),
      paths: z
        .array(
          z
            .string()
            .trim()
            .refine(
              isValidResponsePath,
              `Path must be dot-separated keys (letters, digits, _) or array indexes, at most ${MAX_PATH_DEPTH} deep, e.g. offer.id`
            )
        )
        .min(1, "Pick at least one response path to save")
        .max(MAX_SAVED_PATHS, `At most ${MAX_SAVED_PATHS} response paths can be saved`),
    })
    .strict()
    .nullable()
    .optional(),
  /** Write-only. A sample JSON response; its paths are merged into `response_schema`. */
  response_sample: z
    .string()
    .max(MAX_SAMPLE_BYTES, `Sample response cannot exceed ${MAX_SAMPLE_BYTES / 1024} KB`)
    .optional(),
};

type ApiInput = {
  save_response?: { provider: string; paths: string[] } | null;
  method?: string;
  headers?: Record<string, string>;
  json_path?: string;
  body?: string;
  response_schema?: ResponseField[];
  response_sample?: string;
};

/** Any `{{token}}` — replaced by a plain word to test the body's JSON shape. */
const ANY_TOKEN_RE = /\{\{\s*[a-zA-Z_][a-zA-Z0-9_.]*\s*\}\}/g;

function isJsonBody(api: ApiInput): boolean {
  const ct = Object.entries(api.headers ?? {}).find(([k]) => k.toLowerCase() === "content-type")?.[1];
  return ct === undefined || /json/i.test(ct);
}

/** Validation that needs more than one field. Paths are relative to the api object. */
export function checkApiConfig(api: ApiInput, ctx: z.RefinementCtx): void {
  if (api.body && api.method !== "GET" && isJsonBody(api)) {
    try {
      JSON.parse(api.body.replace(ANY_TOKEN_RE, "x"));
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body"],
        message:
          'Body must be valid JSON. Put {{tokens}} inside quotes, e.g. {"id": "{{user_id}}"}, or set a non-JSON Content-Type header',
      });
    }
  }
  if (api.response_sample !== undefined && api.response_sample.trim()) {
    let sample: unknown;
    try {
      sample = JSON.parse(api.response_sample);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["response_sample"],
        message: "Sample response must be valid JSON",
      });
      return;
    }
    if (sample === null || typeof sample !== "object" || Array.isArray(sample)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["response_sample"],
        message: "Sample response must be a JSON object — {{name.key}} reads keys of an object",
      });
    }
  }
  // The default value path must end at one value. If a listed field sits
  // under it, it points at an object — `{{name}}` would have nothing to print.
  const jsonPath = api.json_path?.trim();
  if (jsonPath) {
    const sampleFields = sampleSchema(api.response_sample);
    const under = [...(api.response_schema ?? []), ...sampleFields].find((f) =>
      f.path.startsWith(`${jsonPath}.`)
    );
    if (under) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["json_path"],
        message: `"${jsonPath}" is an object (it contains ${under.path}) — point the default value path at a single value inside it`,
      });
    }
  }
  // Saved paths must each end at one value — the same rule as json_path.
  if (api.save_response) {
    const known = [...(api.response_schema ?? []), ...sampleSchema(api.response_sample)];
    const savedSeen = new Set<string>();
    for (const [i, path] of api.save_response.paths.entries()) {
      if (savedSeen.has(path)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["save_response", "paths", i], message: `Path "${path}" is listed twice` });
      }
      savedSeen.add(path);
      const under = known.find((f) => f.path.startsWith(`${path}.`));
      if (under) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["save_response", "paths", i],
          message: `"${path}" is an object (it contains ${under.path}) — save a single value inside it`,
        });
      }
    }
  }
  const seen = new Set<string>();
  for (const [i, f] of (api.response_schema ?? []).entries()) {
    if (seen.has(f.path)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["response_schema", i, "path"],
        message: `Path "${f.path}" is listed twice`,
      });
    }
    seen.add(f.path);
  }
}

/** The single-value paths in a sample, or none when it is absent or not JSON. */
function sampleSchema(sample: string | undefined): ResponseField[] {
  if (!sample?.trim()) return [];
  try {
    return deriveResponseSchema(JSON.parse(sample)).fields;
  } catch {
    return [];
  }
}

/** Folds a sample into the schema and drops it, so it is never stored. */
export function finalizeApiConfig<T extends ApiInput>(api: T): Omit<T, "response_sample"> {
  const { response_sample, ...rest } = api;
  if (!response_sample?.trim()) return rest;
  const derived = deriveResponseSchema(JSON.parse(response_sample)).fields;
  return { ...rest, response_schema: mergeResponseSchema(derived, rest.response_schema) };
}
