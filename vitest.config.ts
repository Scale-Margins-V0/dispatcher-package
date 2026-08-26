/**
 * Vitest workspaces: `unit` (default specs) vs `integration` (DB, real HTTP, full app).
 * Inline project names must live under `test.name` so `vitest --project <name>` matches.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    pool: "forks",
    hookTimeout: 60_000,
    testTimeout: 60_000,
    env: {
      /**
       * Stop the AWS SDK probing EC2 instance metadata for credentials.
       *
       * Specs that exercise the send path with no AWS credentials (by design —
       * they assert the failure is logged) otherwise pay ~2s per send while the
       * credential chain waits for 169.254.169.254 to time out. The outcome is
       * identical either way, "Could not load credentials from any providers";
       * only the wait disappears. Left on, three logging specs pass on a laptop
       * and time out against vitest's 5s default on a CI runner.
       */
      AWS_EC2_METADATA_DISABLED: "true",
    },
    projects: [
      {
        test: {
          name: "unit",
          hookTimeout: 60_000,
          testTimeout: 60_000,
          include: ["src/**/*.spec.ts"],
          exclude: [
            "src/**/*.integration.spec.ts",
            "src/dispatch.integration.spec.ts",
          ],
        },
      },
      {
        test: {
          name: "integration",
          hookTimeout: 60_000,
          testTimeout: 60_000,
          include: [
            "src/**/*.integration.spec.ts",
            "src/dispatch.integration.spec.ts",
          ],
          fileParallelism: false,
        },
      },
    ],
  },
});
