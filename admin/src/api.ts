import type {
  AdminActivity,
  AdminOverview,
  AdminVariable,
  DispatchDetail,
  LogPage,
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

export const fetchSession = () => json<{ authenticated: boolean }>("/admin/api/session");
export const login = (username: string, password: string) => json<{ authenticated: boolean }>("/admin/api/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, password }),
});
export const logout = () => json<{ authenticated: boolean }>("/admin/api/logout", {
  method: "POST",
  headers: { "X-Dispatcher-Admin": "1" },
});
export const fetchOverview = () => json<AdminOverview>("/admin/api/overview");
export const fetchActivity = () => json<AdminActivity>("/admin/api/activity");

const jsonBody = (body: unknown): RequestInit => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

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

export const fetchLogs = (params: Record<string, string>) =>
  json<LogPage>(`/admin/api/logs?${new URLSearchParams(params).toString()}`);
export const fetchDispatchDetail = (id: string) =>
  json<DispatchDetail>(`/admin/api/dispatches/${encodeURIComponent(id)}`);
