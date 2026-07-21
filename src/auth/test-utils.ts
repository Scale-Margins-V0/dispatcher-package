/**
 * Spec-only helpers to stand up Better Auth against the in-memory test DB and
 * seed a signed-in-able admin. Kept free of supertest so it doesn't pull test
 * deps into the build; specs create the agent and call the sign-in route.
 */

import { getAuth, initAuth, resetAuthForTests } from "./index.js";

export const TEST_ADMIN_EMAIL = "test-admin@scalemargins.tech";
export const TEST_ADMIN_PASSWORD = "correct-horse-battery-staple-12";
export const SIGN_IN_PATH = "/admin/api/auth/sign-in/email";

/** Bind a fresh auth instance to the current test DB singleton. */
export function setupAuthForTest(): void {
  resetAuthForTests();
  initAuth();
}

/** Create an admin user + the default org so the account can sign in. */
export async function seedTestAdmin(
  email = TEST_ADMIN_EMAIL,
  password = TEST_ADMIN_PASSWORD
): Promise<{ userId: string }> {
  const auth = getAuth();
  const created = await auth.api.createUser({
    body: { email, password, name: "Test Admin", role: "admin" },
  });
  await auth.api.createOrganization({
    body: { name: "ScaleMargin", slug: "scalemargin", userId: created.user.id },
  });
  return { userId: created.user.id };
}

export function teardownAuthForTest(): void {
  resetAuthForTests();
}
