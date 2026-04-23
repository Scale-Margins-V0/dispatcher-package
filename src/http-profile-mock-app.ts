/**
 * Express app for the local profile API mock (same routes as
 * `pnpm run dev:http-profile-mock`). Import in tests to bind an ephemeral port.
 */

import express, { type Express, type Request, type Response } from "express";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** In-memory users keyed by `user_id`, loaded once from `scripts/seed/fixtures/users.json`. */
type FixtureRow = {
  user_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone_no: string | null;
  company_name: string | null;
};

function loadStore(): Map<string, FixtureRow> {
  const raw = readFileSync(
    join(__dirname, "../scripts/seed/fixtures/users.json"),
    "utf8"
  );
  const rows = JSON.parse(raw) as FixtureRow[];
  return new Map(rows.map((r) => [r.user_id, r]));
}

const store = loadStore();

function authOk(req: Request, token: string | undefined): boolean {
  if (!token) return true;
  const h = req.headers.authorization;
  return h === `Bearer ${token}`;
}

function buildProfileRecord(
  row: FixtureRow,
  responseIdField: string
): Record<string, unknown> {
  const email = row.email.trim();
  return {
    [responseIdField]: row.user_id,
    email,
    first_name: row.first_name,
    last_name: row.last_name,
    company_name: row.company_name,
    phone: row.phone_no,
    contact: {
      primaryEmail: email,
    },
  };
}

/**
 * Build the mock profile API app. Pass a custom env object in tests so token/path
 * stay isolated from the developer shell.
 */
export function createHttpProfileMockApp(
  env: NodeJS.ProcessEnv = process.env
): Express {
  const path = env.PROFILE_MOCK_PATH || "/v1/users:batchGet";
  const token = env.PROFILE_MOCK_TOKEN;
  const requestIdField =
    env.PROFILE_MOCK_REQUEST_FIELD || "user_ids";
  const responseRoot = env.PROFILE_MOCK_RESPONSE_ROOT || "users";
  const responseIdField = env.PROFILE_MOCK_RESPONSE_ID_FIELD || "id";

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "http-profile-mock",
      fixtures: store.size,
    });
  });

  app.post(path, (req: Request, res: Response) => {
    if (!authOk(req, token)) {
      res
        .status(401)
        .json({ error: "missing or invalid Authorization bearer" });
      return;
    }

    const ids = req.body?.[requestIdField];
    if (
      !Array.isArray(ids) ||
      ids.some((x: unknown) => typeof x !== "string")
    ) {
      res.status(400).json({
        error: `body.${requestIdField} must be a string[]`,
      });
      return;
    }

    const users: Record<string, unknown>[] = [];
    for (const id of ids) {
      const row = store.get(id);
      if (row) {
        users.push(buildProfileRecord(row, responseIdField));
      }
    }

    res.json({ [responseRoot]: users });
  });

  return app;
}
