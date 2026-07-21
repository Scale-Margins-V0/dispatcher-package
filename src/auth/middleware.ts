/**
 * Session guard for /admin/api — replaces the old cookie-session
 * verifyAdminAccess. Resolves the Better Auth session from request cookies and
 * 401s when absent/expired; attaches the user/session/role to the request.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { getAuth } from "./index.js";

export type AuthedRequest = Request & {
  authUser?: { id: string; email: string; name: string; role?: string | null };
  authSession?: { id: string; activeOrganizationId?: string | null };
};

export async function resolveSession(req: Request) {
  return getAuth().api.getSession({ headers: fromNodeHeaders(req.headers) });
}

export const requireSession: RequestHandler = (req, res, next: NextFunction): void => {
  void resolveSession(req)
    .then((session) => {
      if (!session?.user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const r = req as AuthedRequest;
      r.authUser = {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        role: (session.user as { role?: string | null }).role ?? null,
      };
      r.authSession = {
        id: session.session.id,
        activeOrganizationId:
          (session.session as { activeOrganizationId?: string | null }).activeOrganizationId ??
          null,
      };
      next();
    })
    .catch((error) => {
      res.status(500).json({ error: "Auth check failed" });
      void error;
    });
};

/** Public session probe for the SPA: returns the current user or {authenticated:false}. */
export const sessionProbe: RequestHandler = (req, res): void => {
  void resolveSession(req)
    .then((session) => {
      if (!session?.user) {
        res.json({ authenticated: false });
        return;
      }
      res.json({
        authenticated: true,
        user: {
          id: session.user.id,
          email: session.user.email,
          name: session.user.name,
          role: (session.user as { role?: string | null }).role ?? null,
        },
      });
    })
    .catch(() => {
      res.json({ authenticated: false });
    });
};
