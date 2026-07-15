import type {
  AdminActivity,
  AdminOverview,
  AdminVariable,
  DispatchDetail,
  LogPage,
  OrgMember,
  OrgSummary,
  PendingInvitation,
  SessionInfo,
  VariablePayload,
} from "./types";

const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body as T;
};

const jsonBody = (body: unknown): RequestInit => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// --- Auth (Better Auth endpoints + our session probe) ---
export const fetchSession = () => json<SessionInfo>("/admin/api/session");
export const signIn = (email: string, password: string) =>
  json<{ user?: unknown }>("/admin/api/auth/sign-in/email", { method: "POST", ...jsonBody({ email, password }) });
export const signOut = () =>
  json<unknown>("/admin/api/auth/sign-out", { method: "POST", ...jsonBody({}) });
export const changePassword = (currentPassword: string, newPassword: string) =>
  json<unknown>("/admin/api/auth/change-password", {
    method: "POST",
    ...jsonBody({ currentPassword, newPassword, revokeOtherSessions: true }),
  });
export const acceptInvite = (token: string, name: string, password: string) =>
  json<{ accepted: boolean; email: string }>("/admin/api/accept-invite", {
    method: "POST",
    ...jsonBody({ token, name, password }),
  });

export const fetchOverview = () => json<AdminOverview>("/admin/api/overview");
export const fetchActivity = () => json<AdminActivity>("/admin/api/activity");

// --- Settings: organization, members, invitations ---
export const fetchOrganization = () =>
  json<{ organization: OrgSummary | null }>("/admin/api/settings/organization");
export const updateOrganization = (name: string) =>
  json<{ organization: OrgSummary }>("/admin/api/settings/organization", { method: "PATCH", ...jsonBody({ name }) });
export const fetchMembers = () => json<{ members: OrgMember[] }>("/admin/api/settings/members");
export const updateMemberRole = (memberId: string, role: string) =>
  json<unknown>("/admin/api/settings/members/role", { method: "POST", ...jsonBody({ memberId, role }) });
export const removeMember = (memberIdOrEmail: string) =>
  json<{ removed: boolean }>("/admin/api/settings/members/remove", { method: "POST", ...jsonBody({ memberIdOrEmail }) });
export const fetchInvitations = () =>
  json<{ invitations: PendingInvitation[] }>("/admin/api/settings/invitations");
export const inviteMember = (email: string, role: string) =>
  json<{ invitation: { id: string }; accept_url: string; emailed: boolean }>(
    "/admin/api/settings/invitations",
    { method: "POST", ...jsonBody({ email, role }) }
  );
export const cancelInvitation = (invitationId: string) =>
  json<{ cancelled: boolean }>("/admin/api/settings/invitations/cancel", { method: "POST", ...jsonBody({ invitationId }) });

export const fetchVariables = () =>
  json<{ variables: AdminVariable[] }>("/admin/api/variables");
export const createVariable = (payload: VariablePayload) =>
  json<{ variable: AdminVariable }>("/admin/api/variables", { method: "POST", ...jsonBody(payload) });
export const updateVariable = (name: string, payload: VariablePayload) =>
  json<{ variable: AdminVariable }>(`/admin/api/variables/${encodeURIComponent(name)}`, { method: "PUT", ...jsonBody(payload) });
export const deleteVariable = (name: string) =>
  json<{ deleted: boolean }>(`/admin/api/variables/${encodeURIComponent(name)}`, { method: "DELETE" });
export const validateVariable = (payload: VariablePayload) =>
  json<{ ok: boolean; error?: string; preview?: string }>("/admin/api/variables/validate", { method: "POST", ...jsonBody(payload) });
export const testVariable = (payload: VariablePayload) =>
  json<{ ok: boolean; value?: string; error?: string }>("/admin/api/variables/test", { method: "POST", ...jsonBody(payload) });

export const fetchLogs = (params: Record<string, string>) =>
  json<LogPage>(`/admin/api/logs?${new URLSearchParams(params).toString()}`);
export const fetchDispatchDetail = (id: string) =>
  json<DispatchDetail>(`/admin/api/dispatches/${encodeURIComponent(id)}`);
