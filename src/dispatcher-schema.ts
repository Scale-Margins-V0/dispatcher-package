/**
 * Shape of the `dispatcher:` block in `.env.yaml` — everything about THIS
 * service itself: how it is reached, who may reach it, where it keeps its own
 * state, how it authenticates operators, and how it logs, prunes and reports.
 *
 * The rule for what belongs here, rather than at the top level: if it describes
 * how the dispatcher runs, it is `dispatcher.*`; if it describes what the
 * dispatcher does — whose data it reads, how it sends, what goes in a message —
 * it is a top-level block. One place for "this service" keeps the file from
 * growing a new top-level section for every system concern.
 *
 * Kept in its own module, importing only zod and other pure schemas, because
 * `env-yaml.ts` needs this at module-init time while the resolvers in
 * `dispatcher-settings.ts` need `loadEnvYaml()`. Putting both in one file makes
 * that a cycle, and the schema evaluates to `undefined` at import time.
 */

import { z } from "zod";
import {
  adminSchema,
  loggingSchema,
  retentionSchema,
  stateDatabaseSchema,
  telemetrySchema,
} from "./config/settings-schema.js";

export const DEFAULT_PORT = 3100;

/** Setting both forms of one secret is rejected: the inline value would win silently. */
function exclusivePair(
  data: Record<string, unknown>,
  ctx: z.RefinementCtx,
  key: string
): void {
  if (data[key] && data[`${key}_env`]) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `set ${key} or ${key}_env, not both — the inline value would win and the reference would be silently ignored`,
      path: [`${key}_env`],
    });
  }
}

export const dispatcherSchema = z
  .object({
    // ── How it is reached ──────────────────────────────────────────────────
    // YAML gives a number, but `port: "3100"` from a templated values file is
    // just as likely — coerce rather than fail on a quoted integer.
    port: z.coerce.number().int().min(1).max(65535).optional(),
    public_url: z
      .string()
      .url("must be an absolute URL, e.g. https://dispatcher.example.com")
      .optional(),

    // ── Who may reach it ───────────────────────────────────────────────────
    atlas_key: z.string().min(1).optional(),
    atlas_key_env: z.string().min(1).optional(),
    // A list is the natural YAML form; a comma-separated string is what someone
    // copying the old environment variable will write. Both are accepted.
    atlas_cors_origins: z.union([z.string(), z.array(z.string())]).optional(),
    /** Overrides the console-managed logs token. Unset → the token in the database is used. */
    logs_api_token: z.string().min(1).optional(),
    logs_api_token_env: z.string().min(1).optional(),

    // ── Its own state, auth, and housekeeping ──────────────────────────────
    database: stateDatabaseSchema.optional(),
    admin: adminSchema.optional(),
    retention: retentionSchema.optional(),
    logging: loggingSchema.optional(),
    telemetry: telemetrySchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    exclusivePair(data, ctx, "atlas_key");
    exclusivePair(data, ctx, "logs_api_token");
  });

export type DispatcherSettings = z.infer<typeof dispatcherSchema>;
