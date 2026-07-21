/**
 * Public invite-accept bridge. Because the console is invite-only
 * (disableSignUp), a brand-new invitee cannot self-register — so this endpoint
 * validates their invitation, creates the account server-side, signs them in,
 * and accepts the invitation (joining the org). Mounted BEFORE requireSession.
 */

import express, { type Express, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { queryDb, tableFor } from "../db/dialect-helpers.js";
import { getDb } from "../db/state.js";
import { componentLogger } from "../logging/logger.js";
import { asyncHandler } from "../admin/api/variables.js";
import { getAuth } from "./index.js";

const log = componentLogger("auth.accept");

type InvitationRow = {
  id: string;
  email: string;
  status: string;
  expiresAt: Date | number | string;
};

export const registerAcceptRoute = (app: Express): void => {
  app.post(
    "/admin/api/accept-invite",
    express.json({ limit: "16kb" }),
    asyncHandler(async (req: Request, res: Response) => {
      const token = String(req.body?.token ?? "").trim();
      const name = String(req.body?.name ?? "").trim();
      const password = String(req.body?.password ?? "");
      if (!token || !name || password.length < 12) {
        res
          .status(400)
          .json({ error: "token, name, and a 12+ character password are required" });
        return;
      }

      const dbx = getDb();
      const inv = tableFor(dbx, "invitation");
      const rows: InvitationRow[] = await queryDb(dbx)
        .select()
        .from(inv)
        .where(eq(inv.id, token));
      const invitation = rows[0];
      if (!invitation || invitation.status !== "pending") {
        res.status(404).json({ error: "Invitation not found or already used" });
        return;
      }
      const expiresAt = new Date(invitation.expiresAt).getTime();
      if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
        res.status(410).json({ error: "Invitation has expired" });
        return;
      }

      const auth = getAuth();
      try {
        await auth.api.createUser({
          body: { email: invitation.email, password, name },
        });
      } catch {
        res
          .status(409)
          .json({ error: "An account for this email already exists — sign in instead" });
        return;
      }

      // Sign in the new account, forward the session cookie to the browser, and
      // accept the invitation as that user (Better Auth matches invite email).
      const signIn = await auth.api.signInEmail({
        body: { email: invitation.email, password },
        asResponse: true,
      });
      const setCookies =
        typeof signIn.headers.getSetCookie === "function"
          ? signIn.headers.getSetCookie()
          : [];
      for (const cookie of setCookies) res.append("Set-Cookie", cookie);
      const cookieHeader = setCookies.map((c) => c.split(";")[0]).join("; ");

      try {
        await auth.api.acceptInvitation({
          headers: new Headers(cookieHeader ? { cookie: cookieHeader } : {}),
          body: { invitationId: token },
        });
      } catch (error) {
        // Account is created + signed in; membership accept is best-effort.
        log.warn(
          { err: error instanceof Error ? error : new Error(String(error)) },
          `Account created for ${invitation.email} but accepting the invitation failed`
        );
      }

      res.json({ accepted: true, email: invitation.email });
    })
  );
};
