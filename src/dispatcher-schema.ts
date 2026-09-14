/**
 * Shape of the `dispatcher:` block in `.env.yaml`.
 *
 * Kept in its own module, importing nothing but zod, because `env-yaml.ts`
 * needs the schema at module-init time while the resolvers in
 * `dispatcher-settings.ts` need `loadEnvYaml()`. Putting both in one file makes
 * that a cycle, and the schema evaluates to `undefined` at import time.
 */

import { z } from "zod";

export const DEFAULT_PORT = 3100;

export const dispatcherSchema = z
  .object({
    // YAML gives a number, but `port: "3100"` from a templated values file is
    // just as likely — coerce rather than fail on a quoted integer.
    port: z.coerce.number().int().min(1).max(65535).optional(),
    public_url: z
      .string()
      .url("must be an absolute URL, e.g. https://dispatcher.example.com")
      .optional(),
    atlas_key: z.string().min(1).optional(),
    atlas_key_env: z.string().min(1).optional(),
    // A list is the natural YAML form; a comma-separated string is what someone
    // copying the old environment variable will write. Both are accepted.
    atlas_cors_origins: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.atlas_key && data.atlas_key_env) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "set atlas_key or atlas_key_env, not both — the inline value would win and the reference would be silently ignored",
        path: ["atlas_key_env"],
      });
    }
  });

export type DispatcherSettings = z.infer<typeof dispatcherSchema>;
