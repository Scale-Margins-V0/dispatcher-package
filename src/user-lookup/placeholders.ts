/**
 * Placeholder definitions — the shape of a `{{token}}`.
 *
 * Split out of config.ts so the config loader can depend on `.env.yaml`
 * translation without a cycle. The Postgres `variables` table is the live
 * source of truth (see variables/service.ts); these defaults are the seed for a
 * brand-new deployment and the fallback for processes that never init the DB.
 */

import { z } from "zod";

const apiConfigSchema = z.object({
  method: z.enum(["GET", "POST"]).default("GET"),
  url: z.string(),
  /** Appended to the URL; values take {{tokens}} and are URL-encoded. */
  query: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** What `{{name}}` alone renders. `{{name.a.b}}` always reads from the root. */
  json_path: z.string(),
  body: z.string().optional(),
  timeout_ms: z.number().int().positive().optional(),
  /** Attached call metadata schema — see variables/call-metadata.ts. */
  metadata: z.object({ id: z.string(), required: z.boolean() }).nullable().optional(),
  /** Response values saved against the sent message — see db/schema apiResponseRefs. */
  save_response: z.object({ provider: z.literal("freshchat"), paths: z.array(z.string()) }).nullable().optional(),
  /** The response's addressable paths — for discovery, never a gate. See api-response.ts. */
  response_schema: z
    .array(
      z.object({
        path: z.string(),
        type: z.enum(["string", "number", "boolean", "object", "array", "null"]),
        example: z.string().optional(),
      })
    )
    .optional(),
});

export const placeholderEntrySchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("field"),
    field: z.string(),
    fallback: z.string().optional(),
  }),
  z.object({
    source: z.literal("computed"),
    expr: z.string(),
    fallback: z.string().optional(),
  }),
  z.object({
    source: z.literal("constant"),
    value: z.string(),
    fallback: z.string().optional(),
  }),
  z.object({
    source: z.literal("query"),
    sql: z.string(),
    fallback: z.string().optional(),
  }),
  z.object({
    source: z.literal("api"),
    api: apiConfigSchema,
    fallback: z.string().optional(),
  }),
]);

export type PlaceholderEntry = z.infer<typeof placeholderEntrySchema>;

/** Every source a variable can use. */
export const VARIABLE_SOURCES = ["field", "computed", "constant", "query", "api"] as const;

/**
 * Sources that need a SQL connection to the customer database. In network and
 * mock mode there is none, so these are refused at write time — see
 * variables/guard.ts.
 *
 * `field` is here because the user lookup only ever returns contact details
 * (email, phone). A `field` variable reads an extra column of the source view,
 * which only a database lookup can do; a network lookup has no columns to pick.
 */
export const SQL_ONLY_VARIABLE_SOURCES: readonly PlaceholderEntry["source"][] = ["field", "query"];

export const DEFAULT_PLACEHOLDERS: Record<string, PlaceholderEntry> = {
  first_name: { source: "field", field: "first_name", fallback: "there" },
  last_name: { source: "field", field: "last_name", fallback: "" },
  full_name: {
    source: "computed",
    expr: "first_name + ' ' + last_name",
    fallback: "there",
  },
  company_name: { source: "field", field: "company_name", fallback: "" },
  email: { source: "field", field: "email", fallback: "" },
  unsubscribe_url: {
    source: "computed",
    expr: "env.UNSUBSCRIBE_URL_BASE + '?uid=' + user_id + '&campaign_id=' + campaign_id + '&organization_id=' + organization_id",
    fallback: "#",
  },
  preferences_url: {
    source: "computed",
    expr: "env.PREFERENCES_URL_BASE + '?uid=' + user_id + '&campaign_id=' + campaign_id + '&organization_id=' + organization_id",
    fallback: "#",
  },
};
