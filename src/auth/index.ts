/**
 * Better Auth instance for the admin console. Built once after the state DB is
 * initialized (dialect known), then reused. Provides email/password auth
 * (invite-only), the admin plugin (server-side user creation), and the
 * organization plugin (members + invitations).
 */

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization } from "better-auth/plugins";
import type { DispatcherDb } from "../db/client.js";
import { getDb } from "../db/state.js";
import { sendInvitationEmail } from "./invitations.js";
import { resolveAuthSecret } from "./secret.js";

export type DispatcherAuth = ReturnType<typeof buildAuth>;

let singleton: DispatcherAuth | null = null;

/** Public base URL used for invite links and secure-cookie inference. */
export function authBaseURL(): string {
  const explicit =
    process.env.DISPATCHER_PUBLIC_URL?.trim() ||
    process.env.UNSUBSCRIBE_URL_BASE?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const port = process.env.PORT || "3100";
  return `http://localhost:${port}`;
}

function useSecureCookies(): boolean {
  const flag = process.env.DISPATCHER_ADMIN_COOKIE_SECURE;
  if (flag === "true") return true;
  if (flag === "false") return false;
  return authBaseURL().startsWith("https://");
}

export function buildAuth(dbx: DispatcherDb) {
  const provider = dbx.dialect === "postgres" ? "pg" : dbx.dialect;
  // Runtime value is the real dialect tables; typed loosely so the adapter
  // accepts them regardless of which dialect's table objects we pass.
  const t = dbx.tables as unknown as Record<string, never>;

  // NOTE: the options object is passed as a literal (not annotated) so
  // TypeScript infers the plugin endpoints onto auth.api.
  return betterAuth({
    appName: "ScaleMargin Dispatcher",
    secret: resolveAuthSecret(),
    baseURL: authBaseURL(),
    basePath: "/admin/api/auth",
    trustedOrigins: [authBaseURL()],
    database: drizzleAdapter(dbx.db, {
      provider,
      schema: {
        user: t.user,
        session: t.session,
        account: t.account,
        verification: t.verification,
        organization: t.organization,
        member: t.member,
        invitation: t.invitation,
      },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true, // invite-only; new users are created server-side
      minPasswordLength: 12,
      autoSignIn: true,
    },
    advanced: {
      useSecureCookies: useSecureCookies(),
    },
    plugins: [
      admin(),
      organization({
        sendInvitationEmail: async (data) => {
          await sendInvitationEmail(data);
        },
      }),
    ],
  });
}

/** Build and cache the auth instance from the active state DB. Idempotent. */
export function initAuth(): DispatcherAuth {
  if (!singleton) singleton = buildAuth(getDb());
  return singleton;
}

export function getAuth(): DispatcherAuth {
  if (!singleton) {
    throw new Error("Auth not initialized — initAuth() must run after the state DB is ready");
  }
  return singleton;
}

export function isAuthInitialized(): boolean {
  return singleton !== null;
}

export function resetAuthForTests(): void {
  singleton = null;
}
