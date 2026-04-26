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
    projects: [
      {
        test: {
          name: "unit",
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
