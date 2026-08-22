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
import { componentLogger } from "../logging/logger.js";
import { sendInvitationEmail } from "./invitations.js";
import { resolveAuthSecret } from "./secret.js";

const log = componentLogger("auth");

export type DispatcherAuth = ReturnType<typeof buildAuth>;

let singleton: DispatcherAuth | null = null;

/** `https://host[:port]` for a parseable absolute URL, else null. */
function originOf(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

let warnedUnsubscribePath = false;

/**
 * Public base URL used as Better Auth's `baseURL`, for invite links, and for
 * secure-cookie inference.
 *
 * `DISPATCHER_PUBLIC_URL` is taken verbatim (minus trailing slashes) because a
 * deployment may legitimately mount the dispatcher under a path — see the ngrok
 * double-proxy note in `.env.example`.
 *
 * `UNSUBSCRIBE_URL_BASE` is only a *fallback*, and it routinely carries a path
 * (`…/unsubscribe`, `…/dispatch`) because that is what it is for. Feeding that
 * path into Better Auth moves every auth route under it, so `/admin/api/auth/*`
 * returns a bare 404 and admin sign-in fails with nothing in the logs. Take the
 * origin only, and say so once at boot.
 */
export function authBaseURL(): string {
  const explicit = process.env.DISPATCHER_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const fallback = process.env.UNSUBSCRIBE_URL_BASE?.trim();
  if (fallback) {
    const origin = originOf(fallback);
    if (origin) {
      if (
        origin !== fallback.replace(/\/+$/, "") &&
        !warnedUnsubscribePath &&
        process.env.VITEST !== "true"
      ) {
        warnedUnsubscribePath = true;
        log.warn(
          `UNSUBSCRIBE_URL_BASE ("${fallback}") includes a path; using origin "${origin}" ` +
            "for the admin console instead. Set DISPATCHER_PUBLIC_URL to control this explicitly."
        );
      }
      return origin;
    }
    if (process.env.VITEST !== "true") {
      log.warn(
        `UNSUBSCRIBE_URL_BASE ("${fallback}") is not a valid absolute URL — falling back to localhost. ` +
          "Set DISPATCHER_PUBLIC_URL to the console's public origin."
      );
    }
  }

  const port = process.env.PORT || "3100";
  return `http://localhost:${port}`;
}

function useSecureCookies(): boolean {
  const flag = process.env.DISPATCHER_ADMIN_COOKIE_SECURE;
  if (flag === "true") return true;
  if (flag === "false") return false;
  return authBaseURL().startsWith("https://");
}

/**
 * Origins Better Auth will accept requests from. The API's own origin always
 * counts; `DISPATCHER_TRUSTED_ORIGINS` (comma-separated) adds more when the
 * console is served from another host. In non-production we also trust the Vite
 * dev server (`pnpm dev:admin` serves the SPA on :5173 and proxies to the API),
 * which would otherwise be rejected as an invalid origin.
 */
export function authTrustedOrigins(): string[] {
  // Entries are matched against a request's Origin header, which never carries
  // a path — so normalize to origins. A configured value with a path silently
  // matches nothing.
  const origins = new Set<string>([originOf(authBaseURL()) ?? authBaseURL()]);
  for (const entry of (process.env.DISPATCHER_TRUSTED_ORIGINS ?? "").split(",")) {
    const trimmed = entry.trim().replace(/\/+$/, "");
    if (trimmed) origins.add(originOf(trimmed) ?? trimmed);
  }
  if (process.env.NODE_ENV !== "production") {
    const devPort = process.env.ADMIN_DEV_PORT || "5173";
    origins.add(`http://localhost:${devPort}`);
    origins.add(`http://127.0.0.1:${devPort}`);
  }
  return [...origins];
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
    trustedOrigins: authTrustedOrigins(),
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
