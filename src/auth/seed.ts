/**
 * Seed the default ScaleMargin owner + organization on first boot, so a fresh
 * deployment is immediately usable. Idempotent: does nothing once any user
 * exists. If no password is provided via env, a strong one is generated and
 * revealed exactly once (log + a 0600 file); an env-provided password is never
 * logged.
 */

import { chmodSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { getDb } from "../db/state.js";
import { queryDb, tableFor } from "../db/dialect-helpers.js";
import { componentLogger } from "../logging/logger.js";
import { getAuth } from "./index.js";

const log = componentLogger("auth");

const DEFAULT_EMAIL = "admin@scalemargins.tech";
const DEFAULT_ORG_NAME = "ScaleMargin";
const DEFAULT_ORG_SLUG = "scalemargin";
const CREDENTIALS_FILE =
  process.env.DISPATCHER_ADMIN_CREDENTIALS_FILE || "./data/initial-admin-credentials.txt";

/** ~20 char password with mixed classes, no ambiguous chars. */
export function generateStrongPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
  const bytes = randomBytes(20);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

async function anyUserExists(): Promise<boolean> {
  const dbx = getDb();
  const rows: unknown[] = await queryDb(dbx)
    .select({ id: tableFor(dbx, "user").id })
    .from(tableFor(dbx, "user"))
    .limit(1);
  return rows.length > 0;
}

export async function seedDefaultAdmin(): Promise<void> {
  if (await anyUserExists()) return;

  const email = process.env.DISPATCHER_ADMIN_EMAIL?.trim() || DEFAULT_EMAIL;
  const envPassword = process.env.DISPATCHER_ADMIN_PASSWORD?.trim();
  const password = envPassword || generateStrongPassword();
  const generated = !envPassword;

  const auth = getAuth();
  const created = await auth.api.createUser({
    body: {
      email,
      password,
      name: "ScaleMargin Admin",
      role: "admin", // global admin-plugin role (server-side user management)
    },
  });

  await auth.api.createOrganization({
    body: {
      name: DEFAULT_ORG_NAME,
      slug: DEFAULT_ORG_SLUG,
      userId: created.user.id, // creator becomes org owner
    },
  });

  if (generated) {
    try {
      writeFileSync(
        CREDENTIALS_FILE,
        `ScaleMargin Dispatcher — initial admin credentials\n` +
          `email: ${email}\npassword: ${password}\n\n` +
          `Sign in at /admin, then change this password and delete this file.\n`,
        { mode: 0o600 }
      );
      try {
        chmodSync(CREDENTIALS_FILE, 0o600);
      } catch {
        /* best-effort */
      }
    } catch (error) {
      log.warn(
        { err: error instanceof Error ? error : new Error(String(error)) },
        "Could not write the initial-admin credentials file"
      );
    }
    log.warn(
      `Seeded default admin ${email} with a GENERATED password. It is shown ONCE here and saved to ` +
        `${CREDENTIALS_FILE} (chmod 600):\n\n    ${password}\n\n` +
        "Sign in at /admin, change it, then delete that file. Set DISPATCHER_ADMIN_PASSWORD to control it."
    );
  } else {
    log.info(`Seeded default admin ${email} (password from DISPATCHER_ADMIN_PASSWORD) and organization "${DEFAULT_ORG_NAME}".`);
  }
}
