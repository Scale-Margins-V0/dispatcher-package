/**
 * Invitation delivery. The invite link is always available in the admin GUI;
 * this additionally emails it through the configured provider (SES/SendGrid)
 * when one is set up. It never throws — a failed email must not fail the invite.
 */

import { componentLogger } from "../logging/logger.js";
import { authBaseURL } from "./index.js";

const log = componentLogger("auth.invitations");

type InvitationEmailData = {
  email: string;
  invitation: { id: string };
  organization?: { name?: string } | null;
  inviter?: { user?: { name?: string; email?: string } } | null;
};

/** The URL an invitee opens to set up their account and join. */
export function inviteAcceptUrl(invitationId: string): string {
  return `${authBaseURL()}/admin/#settings/accept?token=${encodeURIComponent(invitationId)}`;
}

export async function sendInvitationEmail(data: InvitationEmailData): Promise<void> {
  const url = inviteAcceptUrl(data.invitation.id);
  const emailProvider = process.env.EMAIL_PROVIDER?.trim();
  if (!emailProvider) {
    // No email configured — the link is surfaced in the GUI instead.
    log.info(`Invitation created for ${data.email} (no email provider; share the link from the console)`);
    return;
  }
  try {
    const { getProvider } = await import("../providers/index.js");
    const from = process.env.FROM_EMAIL || "noreply@example.com";
    const orgName = data.organization?.name || "ScaleMargin Dispatcher";
    const inviter = data.inviter?.user?.name || data.inviter?.user?.email || "An administrator";
    const html =
      `<p>${escapeHtml(inviter)} invited you to the <strong>${escapeHtml(orgName)}</strong> operations console.</p>` +
      `<p><a href="${url}">Accept the invitation and set up your account</a></p>` +
      `<p>Or paste this link into your browser:<br>${escapeHtml(url)}</p>`;
    const result = await getProvider().send({
      to: data.email,
      from,
      subject: `You're invited to ${orgName}`,
      html,
    });
    if (!result.success) {
      log.warn(`Invitation email to ${data.email} was not accepted: ${result.error ?? "unknown"}`);
    }
  } catch (error) {
    log.warn(
      { err: error instanceof Error ? error : new Error(String(error)) },
      `Failed to send invitation email to ${data.email}`
    );
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
