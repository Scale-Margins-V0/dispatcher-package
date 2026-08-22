import type {
  AdminActivity,
  AdminOverview,
  AdminVariable,
  CampaignEventPage,
  CampaignInfo,
  CampaignOutboxPage,
  CampaignPage,
  DispatchDetail,
  DispatchPage,
  LogPage,
  LogWebhookInput,
  LogWebhookSettings,
  OrgMember,
  OrgSummary,
  PendingInvitation,
  RecipientPage,
  RecipientTimeline,
  SessionInfo,
  VariablePayload,
  VariableTestResult,
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

// --- Observability: log webhook + global API keys ---
export const fetchLogWebhook = () =>
  json<{ webhook: LogWebhookSettings }>("/admin/api/settings/log-webhook");
export const saveLogWebhook = (cfg: LogWebhookInput) =>
  json<{ webhook: LogWebhookSettings }>("/admin/api/settings/log-webhook", { method: "PUT", ...jsonBody(cfg) });
export const testLogWebhook = (cfg: LogWebhookInput) =>
  json<{ ok: boolean; status?: number; error?: string }>("/admin/api/settings/log-webhook/test", { method: "POST", ...jsonBody(cfg) });
export const fetchApiKeys = () =>
  json<{ api_keys: import("./types").ApiKeyRecord[] }>("/admin/api/settings/api-keys");
export const createApiKey = (name: string) =>
  json<{ api_key: import("./types").ApiKeyRecord }>("/admin/api/settings/api-keys", { method: "POST", ...jsonBody({ name }) });
export const rotateApiKey = (id: string) =>
  json<{ api_key: import("./types").ApiKeyRecord }>(`/admin/api/settings/api-keys/${encodeURIComponent(id)}/rotate`, { method: "POST", ...jsonBody({}) });
export const revokeApiKey = (id: string) =>
  json<{ revoked: boolean }>(`/admin/api/settings/api-keys/${encodeURIComponent(id)}/revoke`, { method: "POST", ...jsonBody({}) });
export const fetchPlatformSecrets = () =>
  json<{ secrets: Array<{ name: string; value: string }> }>("/admin/api/settings/platform-secrets");

// --- Server API: what Atlas connects to ---
export const fetchConnection = () =>
  json<import("./types").ConnectionInfo>("/admin/api/settings/connection");

/**
 * Check a key against the real external endpoint, with the same bearer header
 * Atlas sends — so it exercises the actual router, middleware and credential
 * rather than an admin-side simulation.
 *
 * Uses a SAME-ORIGIN relative path on purpose. The external router serves no
 * CORS headers (it is server-to-server; a browser must never hold this key), so
 * an absolute cross-origin URL would fail preflight and report "unreachable"
 * for a perfectly good key — which is exactly what happens under `dev:admin`,
 * where the console is on :5173 and the API on :3100.
 *
 * What this does NOT prove is that ScaleMargin can reach this host from the
 * public internet. No browser check can: the operator's browser is not Atlas.
 * That is what Atlas's own verification step is for.
 */
export const verifyServerApiKey = async (
  key: string
): Promise<{ ok: boolean; status: number; message?: string }> => {
  try {
    const response = await fetch("/api/v1/data-plane/build", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    return { ok: response.ok, status: response.status, message: body.message };
  } catch (reason) {
    return {
      ok: false,
      status: 0,
      message: reason instanceof Error ? reason.message : "Request failed",
    };
  }
};
/** Legacy helpers kept for existing clients while named API keys replace the UI. */
export const fetchLogsTokenStatus = () =>
  json<{ configured: boolean; updated_at: string | null }>("/admin/api/settings/logs-token");
export const generateLogsToken = () =>
  json<{ token: string }>("/admin/api/settings/logs-token", { method: "POST", ...jsonBody({}) });

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
  json<VariableTestResult>("/admin/api/variables/test", { method: "POST", ...jsonBody(payload) });

export const fetchLogs = (params: Record<string, string>) =>
  json<LogPage>(`/admin/api/logs?${new URLSearchParams(params).toString()}`);
export const fetchDispatchDetail = (id: string) =>
  json<DispatchDetail>(`/admin/api/dispatches/${encodeURIComponent(id)}`);

// --- Campaign console ---
const query = (params: Record<string, string | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const s = search.toString();
  return s ? `?${s}` : "";
};
type PageParams = { q?: string; cursor?: string; limit?: string };

export const fetchCampaigns = (params: PageParams = {}) =>
  json<CampaignPage>(`/admin/api/campaigns${query(params)}`);
export const fetchCampaign = (id: string) =>
  json<{ campaign: CampaignInfo }>(`/admin/api/campaigns/${encodeURIComponent(id)}`);
export const fetchCampaignRecipients = (id: string, params: PageParams & { status?: string } = {}) =>
  json<RecipientPage>(`/admin/api/campaigns/${encodeURIComponent(id)}/recipients${query(params)}`);
export const fetchCampaignRecipient = (id: string, userId: string) =>
  json<RecipientTimeline>(
    `/admin/api/campaigns/${encodeURIComponent(id)}/recipients/${encodeURIComponent(userId)}`
  );
export const fetchCampaignEvents = (id: string, params: PageParams & { event?: string } = {}) =>
  json<CampaignEventPage>(`/admin/api/campaigns/${encodeURIComponent(id)}/events${query(params)}`);
export const fetchCampaignRuns = (id: string, params: PageParams = {}) =>
  json<DispatchPage>(`/admin/api/campaigns/${encodeURIComponent(id)}/runs${query(params)}`);
export const fetchCampaignOutbox = (id: string, params: PageParams & { status?: string } = {}) =>
  json<CampaignOutboxPage>(`/admin/api/campaigns/${encodeURIComponent(id)}/outbox${query(params)}`);
