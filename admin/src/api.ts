import type { AdminActivity, AdminOverview } from "./types";

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
