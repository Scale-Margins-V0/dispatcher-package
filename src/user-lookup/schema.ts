/**
 * `.env.yaml` → `user_lookup` schema.
 *
 * Three modes, discriminated on `mode`. Every arm is `.strict()`, so a key that
 * belongs to a different mode is a validation error rather than something
 * silently ignored — `source:` under `network` is almost always a half-finished
 * migration, and failing loudly beats resolving nobody at run time.
 */

import { z } from "zod";

const idTypeSchema = z.enum(["string", "int", "bigint", "uuid"]);

/** Logical name → column (database) or requested field name (network). */
const fieldsSchema = z.record(z.string(), z.string());

const batchSchema = z
  .object({
    max_ids_per_query: z.number().int().positive().max(10_000).default(1000),
    dedupe: z.boolean().default(true),
  })
  .strict();

/**
 * Credentials for the customer database.
 *
 * Every field is optional: an operator may still supply them through `DB_*` for
 * the length of the deprecation window. Which ones are actually required is a
 * function of the backend, so it is enforced at boot (`ensureLookupUsable`)
 * where the env fallback is visible, not here.
 */
const connectionSchema = z
  .object({
    host: z.string().optional(),
    port: z.number().int().positive().optional(),
    user: z.string().optional(),
    password: z.string().optional(),
    password_env: z.string().optional(),
    database: z.string().optional(),
    ssl: z.boolean().optional(),
    /** sqlite only. */
    file: z.string().optional(),
  })
  .strict();

const sourceSchema = z
  .object({
    kind: z.enum(["table", "view"]).default("table"),
    name: z.string().min(1),
    id_column: z.string().min(1),
    id_type: idTypeSchema.default("string"),
  })
  .strict();

const networkSchema = z
  .object({
    url: z.string().url(),
    token: z.string().min(1).optional(),
    token_env: z.string().min(1).optional(),
    timeout_ms: z.number().int().positive().default(3000),
    retries: z.number().int().min(0).max(5).default(2),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (!cfg.token && !cfg.token_env) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "network lookup needs a bearer token: set `token` inline, or `token_env` naming a variable in .env",
        path: ["token"],
      });
    }
  });

const databaseLookupSchema = z
  .object({
    mode: z.literal("database"),
    backend: z.enum(["mysql", "postgres", "sqlite"]),
    connection: connectionSchema.optional(),
    source: sourceSchema,
    fields: fieldsSchema,
    batch: batchSchema.optional(),
  })
  .strict();

const networkLookupSchema = z
  .object({
    mode: z.literal("network"),
    network: networkSchema,
    fields: fieldsSchema,
    batch: batchSchema.optional(),
  })
  .strict();

/**
 * Reads nothing and calls nobody — so it takes no configuration at all. A mock
 * that looks configured is worse than one that obviously is not.
 */
const mockLookupSchema = z.object({ mode: z.literal("mock") }).strict();

export const userLookupSchema = z.discriminatedUnion("mode", [
  databaseLookupSchema,
  networkLookupSchema,
  mockLookupSchema,
]);

export type UserLookupYaml = z.infer<typeof userLookupSchema>;
export type DatabaseLookupYaml = z.infer<typeof databaseLookupSchema>;
export type NetworkLookupYaml = z.infer<typeof networkLookupSchema>;
export type LookupConnection = z.infer<typeof connectionSchema>;

/** The mode an operator selected. Drives the query-variable guard and `/state`. */
export type LookupMode = UserLookupYaml["mode"];
