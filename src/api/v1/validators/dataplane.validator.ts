/**
 * Request schemas for the external (Atlas) data-plane surface.
 *
 * The wire shape mirrors the authoring UI one-for-one — a variable is a
 * `name`, a `definition` (discriminated by `source`), a `fallback`, a `sample`
 * and an enabled flag — so a form maps onto a payload without a translation
 * layer in between.
 *
 * `definition` is a discriminated union rather than a flat bag of optionals:
 * a `query` definition cannot carry a `field`, and an invalid `source` fails
 * before any of the branch-specific rules run, which keeps the error the caller
 * sees pointed at the thing that is actually wrong.
 */

import { z } from "zod";
import { validateComputedExpression } from "../../../personalize.js";
import { HEADER_MASK } from "../../../variables/redaction.js";

/**
 * A placeholder name is whatever the operator types between `{{ }}`: no
 * spaces, no punctuation, must start with a letter or underscore. It has to
 * survive being embedded in a template and matched by the resolver's token
 * regex, so this is deliberately narrower than "anything without a space".
 */
export const PLACEHOLDER_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const placeholderName = z
  .string()
  .trim()
  .min(1, "Placeholder name cannot be empty")
  .max(191, "Placeholder name cannot exceed 191 characters")
  .regex(
    PLACEHOLDER_NAME_RE,
    "Placeholder name must start with a letter or underscore and contain only letters, digits and underscores — no spaces"
  );

/*
 * Definition — one branch per source type
 */

/** `field` — replaced straight from a column of the record already fetched. */
export const ZFieldDefinitionSchema = z.object({
  source: z.literal("field"),
  field: z
    .string()
    .trim()
    .min(1, "Column name is required for a field variable")
    .max(191, "Column name cannot exceed 191 characters"),
});

/**
 * `computed` — joins fields and literals into a new string. Validated against
 * the real evaluator, so anything accepted here also resolves at send time.
 */
export const ZComputedDefinitionSchema = z.object({
  source: z.literal("computed"),
  expr: z
    .string()
    .trim()
    .min(1, "Expression is required for a computed variable")
    .max(4000, "Expression cannot exceed 4000 characters")
    .superRefine((expr, ctx) => {
      const result = validateComputedExpression(expr);
      if (!result.ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid expression: ${result.error}` });
      }
    }),
});

/** `constant` — a fixed string, changed in one place instead of forty templates. */
export const ZConstantDefinitionSchema = z.object({
  source: z.literal("constant"),
  value: z.string().max(8000, "Constant value cannot exceed 8000 characters"),
});

/**
 * `query` — a read-only statement run inside the client's network at send
 * time. Read-only is enforced here as a guardrail, not as a security boundary:
 * the real protection is the credentials the dispatcher connects with.
 */
export const ZQueryDefinitionSchema = z.object({
  source: z.literal("query"),
  sql: z
    .string()
    .trim()
    .min(1, "SQL is required for a query variable")
    .max(8000, "SQL cannot exceed 8000 characters")
    .refine((sql) => /^\s*(select|with)\b/i.test(sql), "SQL must be a SELECT or WITH statement")
    .refine((sql) => !sql.includes(";"), "SQL must be a single statement — remove the semicolon"),
});

export const ZApiConfigSchema = z.object({
  method: z.enum(["GET", "POST"]).default("GET"),
  url: z
    .string()
    .trim()
    .min(1, "URL is required for an api variable")
    .max(2000, "URL cannot exceed 2000 characters")
    .refine(
      (url) => /^https?:\/\//i.test(url),
      "URL must start with http:// or https:// (tokens such as {{user_id}} are interpolated at send time)"
    ),
  headers: z
    .record(z.string(), z.string().max(4000))
    .refine(
      (headers) => Object.keys(headers).every((key) => /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key)),
      "Header names may only contain HTTP token characters"
    )
    .optional(),
  /** Dotted path into the JSON response; empty means "use the whole body". */
  json_path: z
    .string()
    .trim()
    .max(200, "JSON path cannot exceed 200 characters")
    .default(""),
  body: z.string().max(8000, "Request body cannot exceed 8000 characters").optional(),
  timeout_ms: z
    .number()
    .int()
    .min(100, "Timeout must be at least 100ms")
    .max(30_000, "Timeout cannot exceed 30000ms")
    .optional(),
});

/** `api` — an HTTP call to a service the client already runs. */
export const ZApiDefinitionSchema = z.object({
  source: z.literal("api"),
  api: ZApiConfigSchema,
});

export const ZVariableDefinitionSchema = z.discriminatedUnion(
  "source",
  [
    ZFieldDefinitionSchema,
    ZComputedDefinitionSchema,
    ZConstantDefinitionSchema,
    ZQueryDefinitionSchema,
    ZApiDefinitionSchema,
  ],
  {
    errorMap: (issue, ctx) =>
      issue.code === z.ZodIssueCode.invalid_union_discriminator
        ? { message: "source must be one of: field, computed, constant, query, api" }
        : { message: ctx.defaultError },
  }
);

export type ZVariableDefinition = z.infer<typeof ZVariableDefinitionSchema>;

/**
 * Rendered preview for the fictional sample record. Supplied by the caller
 * rather than computed on write, because for `query`/`api` the only honest
 * sample is the one the live test produced inside the client's network.
 */
const sample = z
  .string()
  .max(4000, "Sample cannot exceed 4000 characters")
  .nullable();

const fallback = z
  .string()
  .max(4000, "Fallback cannot exceed 4000 characters")
  .nullable();

export const ZCreateVariableSchema = z.object({
  name: placeholderName,
  definition: ZVariableDefinitionSchema,
  fallback: fallback.optional(),
  sample: sample.optional(),
  /** Status. A disabled variable keeps its definition but stops resolving. */
  enabled: z.boolean().default(true),
});

export type ZCreateVariable = z.infer<typeof ZCreateVariableSchema>;

/**
 * Every field is optional, but the whole `definition` moves together — a
 * partial definition would let a caller turn a `query` into a `field` while
 * leaving the SQL behind, which is a half-migrated row nobody asked for.
 */
export const ZUpdateVariableSchema = z
  .object({
    name: placeholderName.optional(),
    definition: ZVariableDefinitionSchema.optional(),
    fallback: fallback.optional(),
    sample: sample.optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (patch) => Object.keys(patch).length > 0,
    "Request body must contain at least one field to update"
  );

export type ZUpdateVariable = z.infer<typeof ZUpdateVariableSchema>;

export const ZVariableNameParamSchema = z.object({ name: placeholderName });

export type ZVariableNameParam = z.infer<typeof ZVariableNameParamSchema>;

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/**
 * Query strings are always strings, so these coerce. `.default()` wraps the
 * coercion, which means an omitted parameter takes the default without being
 * run through `Number("")` — the difference between "no page given" and
 * "page 0", which must not be conflated.
 */
const page = z.coerce
  .number({ invalid_type_error: "page must be a whole number" })
  .int("page must be a whole number")
  .min(1, "page starts at 1")
  .default(1);

const limit = z.coerce
  .number({ invalid_type_error: "limit must be a whole number" })
  .int("limit must be a whole number")
  .min(1, "limit must be at least 1")
  .max(MAX_PAGE_SIZE, `limit cannot exceed ${MAX_PAGE_SIZE}`)
  .default(DEFAULT_PAGE_SIZE);

export const ZListVariablesQuerySchema = z.object({
  source: z.enum(["field", "computed", "constant", "query", "api"]).optional(),
  /** `?enabled=true` / `?enabled=false`; omitted returns both. */
  enabled: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  /** Case-insensitive substring match on the placeholder name. */
  q: z.string().trim().max(191).optional(),
  /** 1-based. Filters are applied before the page is cut. */
  page,
  limit,
});

export type ZListVariablesQuery = z.infer<typeof ZListVariablesQuerySchema>;

/*
 * Campaigns
 */

/**
 * A program id is whatever ScaleMargin put on the wire — a campaign id, or a
 * drip sequence id. It is opaque here, so this only bounds the length and
 * refuses the empty string rather than imposing a shape the platform never
 * promised.
 */
const programId = z
  .string()
  .trim()
  .min(1, "Campaign id cannot be empty")
  .max(191, "Campaign id cannot exceed 191 characters");

export const ZProgramIdParamSchema = z.object({ programId });

export type ZProgramIdParam = z.infer<typeof ZProgramIdParamSchema>;

/** ISO-8601 in, Date out. Rejects "yesterday" and other things Date accepts loosely. */
const isoDate = z
  .string()
  .datetime({ offset: true, message: "Must be an ISO-8601 timestamp, e.g. 2026-08-17T09:00:00Z" })
  .transform((value) => new Date(value));

export const ZListCampaignsQuerySchema = z
  .object({
    organization_id: z.string().trim().max(191).optional(),
    channel: z.string().trim().max(16).optional(),
    program_kind: z.enum(["campaign", "drip"]).optional(),
    /** Case-insensitive substring match on the campaign id. */
    q: z.string().trim().max(191).optional(),
    /** Bounds on last activity, not on when the campaign was created. */
    from: isoDate.optional(),
    to: isoDate.optional(),
    page,
    limit,
  })
  .refine(
    (query) => !query.from || !query.to || query.from <= query.to,
    { message: "from must be earlier than to", path: ["from"] }
  );

export type ZListCampaignsQuery = z.infer<typeof ZListCampaignsQuerySchema>;

export const ZListSendsQuerySchema = z.object({
  status: z.enum(["sent", "failed"]).optional(),
  user_id: z.string().trim().max(191).optional(),
  dispatch_run_id: z.string().trim().max(36).optional(),
  page,
  limit,
});

export type ZListSendsQuery = z.infer<typeof ZListSendsQuerySchema>;

/*
 * Logs
 */

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

export type LogLevelName = (typeof LOG_LEVELS)[number];

/**
 * `since=15m` / `2h` / `7d` — a relative window, which is what an operator
 * actually wants when reading logs. Absolute `from`/`to` are also accepted and
 * win over `since` when both are given.
 */
const RELATIVE_WINDOW_RE = /^(\d+)\s*(s|m|h|d)$/i;

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseRelativeWindow(value: string, now = Date.now()): Date | null {
  const match = RELATIVE_WINDOW_RE.exec(value.trim());
  if (!match) return null;
  const amount = parseInt(match[1]!, 10);
  const unit = UNIT_MS[match[2]!.toLowerCase()];
  if (!unit || amount <= 0) return null;
  return new Date(now - amount * unit);
}

export const ZListLogsQuerySchema = z
  .object({
    /** Exact level. Ignored when `min_level` is also set. */
    level: z.enum(LOG_LEVELS).optional(),
    /** This level and everything more severe. */
    min_level: z.enum(LOG_LEVELS).optional(),
    component: z.string().trim().max(64).optional(),
    campaign_id: z.string().trim().max(191).optional(),
    request_id: z.string().trim().max(64).optional(),
    /** Case-sensitive substring match on the message. */
    q: z.string().trim().max(200).optional(),
    since: z
      .string()
      .trim()
      .max(16)
      .refine(
        (value) => parseRelativeWindow(value) !== null,
        "since must look like 15m, 2h or 7d"
      )
      .optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    order: z.enum(["asc", "desc"]).default("desc"),
    page,
    limit,
  })
  .refine(
    (query) => !query.from || !query.to || query.from <= query.to,
    { message: "from must be earlier than to", path: ["from"] }
  );

export type ZListLogsQuery = z.infer<typeof ZListLogsQuerySchema>;

/** Log ids are UUIDs minted by the sink. */
export const ZLogIdParamSchema = z.object({
  id: z.string().trim().min(1, "Log id cannot be empty").max(64),
});

export type ZLogIdParam = z.infer<typeof ZLogIdParamSchema>;

/** Re-exported so the controller and the docs quote one mask, not two. */
export { HEADER_MASK };
