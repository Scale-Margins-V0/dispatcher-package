/**
 * Settings API: organization, members, invitations. Thin authenticated proxies
 * to Better Auth's server API, acting as the signed-in user (via their request
 * headers) so Better Auth enforces org-role permissions. Mounted under
 * requireSession in registerAdminRoutes.
 */

import express, { type Express, type Request, type Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { getAuth } from "../../auth/index.js";
import { inviteAcceptUrl } from "../../auth/invitations.js";
import { asyncHandler } from "./variables.js";

function headers(req: Request) {
  return fromNodeHeaders(req.headers);
}

/** The signed-in user's organization id (single-org model → their first org). */
async function resolveOrgId(req: Request): Promise<string | null> {
  const orgs = (await getAuth().api.listOrganizations({ headers: headers(req) })) as Array<{
    id: string;
  }>;
  return orgs?.[0]?.id ?? null;
}

export const registerMemberRoutes = (app: Express): void => {
  const json = express.json({ limit: "16kb" });
  const auth = () => getAuth();

  app.get(
    "/admin/api/settings/organization",
    asyncHandler(async (req: Request, res: Response) => {
      const organizationId = await resolveOrgId(req);
      if (!organizationId) {
        res.json({ organization: null, members: [], invitations: [] });
        return;
      }
      const org = await auth().api.getFullOrganization({
        headers: headers(req),
        query: { organizationId },
      });
      res.json({ organization: org });
    })
  );

  app.patch(
    "/admin/api/settings/organization",
    json,
    asyncHandler(async (req: Request, res: Response) => {
      const organizationId = await resolveOrgId(req);
      if (!organizationId) {
        res.status(404).json({ error: "No organization" });
        return;
      }
      const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      if (!name) {
        res.status(400).json({ error: "name is required" });
        return;
      }
      const org = await auth().api.updateOrganization({
        headers: headers(req),
        body: { organizationId, data: { name } },
      });
      res.json({ organization: org });
    })
  );

  app.get(
    "/admin/api/settings/members",
    asyncHandler(async (req: Request, res: Response) => {
      const organizationId = await resolveOrgId(req);
      if (!organizationId) {
        res.json({ members: [] });
        return;
      }
      const org = (await auth().api.getFullOrganization({
        headers: headers(req),
        query: { organizationId },
      })) as { members?: unknown[] } | null;
      res.json({ members: org?.members ?? [] });
    })
  );

  app.post(
    "/admin/api/settings/members/role",
    json,
    asyncHandler(async (req: Request, res: Response) => {
      const organizationId = await resolveOrgId(req);
      const memberId = String(req.body?.memberId ?? "");
      const role = String(req.body?.role ?? "");
      if (!organizationId || !memberId || !role) {
        res.status(400).json({ error: "memberId and role are required" });
        return;
      }
      const result = await auth().api.updateMemberRole({
        headers: headers(req),
        body: { organizationId, memberId, role: role as "member" | "admin" | "owner" },
      });
      res.json({ member: result });
    })
  );

  app.post(
    "/admin/api/settings/members/remove",
    json,
    asyncHandler(async (req: Request, res: Response) => {
      const organizationId = await resolveOrgId(req);
      const memberIdOrEmail = String(req.body?.memberIdOrEmail ?? "");
      if (!organizationId || !memberIdOrEmail) {
        res.status(400).json({ error: "memberIdOrEmail is required" });
        return;
      }
      await auth().api.removeMember({
        headers: headers(req),
        body: { organizationId, memberIdOrEmail },
      });
      res.json({ removed: true });
    })
  );

  app.get(
    "/admin/api/settings/invitations",
    asyncHandler(async (req: Request, res: Response) => {
      const organizationId = await resolveOrgId(req);
      if (!organizationId) {
        res.json({ invitations: [] });
        return;
      }
      const invitations = (await auth().api.listInvitations({
        headers: headers(req),
        query: { organizationId },
      })) as Array<{ id: string; status: string }>;
      const pending = (invitations ?? [])
        .filter((i) => i.status === "pending")
        .map((i) => ({ ...i, accept_url: inviteAcceptUrl(i.id) }));
      res.json({ invitations: pending });
    })
  );

  app.post(
    "/admin/api/settings/invitations",
    json,
    asyncHandler(async (req: Request, res: Response) => {
      const organizationId = await resolveOrgId(req);
      const email = String(req.body?.email ?? "").trim();
      const role = (String(req.body?.role ?? "member") || "member") as
        | "member"
        | "admin"
        | "owner";
      if (!organizationId || !email) {
        res.status(400).json({ error: "email is required" });
        return;
      }
      const invitation = (await auth().api.createInvitation({
        headers: headers(req),
        body: { organizationId, email, role, resend: true },
      })) as { id: string } | null;
      if (!invitation) {
        res.status(400).json({ error: "Could not create invitation" });
        return;
      }
      res.status(201).json({
        invitation,
        accept_url: inviteAcceptUrl(invitation.id),
        emailed: Boolean(process.env.EMAIL_PROVIDER),
      });
    })
  );

  app.post(
    "/admin/api/settings/invitations/cancel",
    json,
    asyncHandler(async (req: Request, res: Response) => {
      const invitationId = String(req.body?.invitationId ?? "");
      if (!invitationId) {
        res.status(400).json({ error: "invitationId is required" });
        return;
      }
      await auth().api.cancelInvitation({
        headers: headers(req),
        body: { invitationId },
      });
      res.json({ cancelled: true });
    })
  );
};
