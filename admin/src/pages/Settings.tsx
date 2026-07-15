import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  cancelInvitation,
  changePassword,
  fetchInvitations,
  fetchLogsTokenStatus,
  fetchLogWebhook,
  fetchMembers,
  fetchOrganization,
  generateLogsToken,
  inviteMember,
  removeMember,
  saveLogWebhook,
  testLogWebhook,
  updateMemberRole,
  updateOrganization,
} from "../api";
import { AlertIcon, CheckIcon, CopyIcon, ShieldIcon, UsersIcon } from "../icons";
import type {
  LogLevelName,
  LogWebhookSettings,
  OrgMember,
  OrgSummary,
  PendingInvitation,
  SessionUser,
} from "../types";

type Tab = "members" | "invitations" | "account" | "organization" | "observability";
const TABS: Array<[Tab, string]> = [
  ["members", "Members"],
  ["invitations", "Invitations"],
  ["account", "Account"],
  ["organization", "Organization"],
  ["observability", "Observability"],
];
const ROLES = ["owner", "admin", "member"];
const LOG_LEVELS: LogLevelName[] = ["trace", "debug", "info", "warn", "error", "fatal"];

function readTab(): Tab {
  const seg = window.location.hash.replace(/^#\/?/, "").split("?")[0].split("/")[1];
  return (TABS.find(([t]) => t === seg)?.[0] ?? "members") as Tab;
}

function Badge({ tone = "muted", children }: { tone?: string; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function ErrorNote({ message }: { message: string }) {
  return (
    <div className="error-state">
      <AlertIcon />
      <strong>Settings</strong>
      <p>{message}</p>
    </div>
  );
}

function Members({ me }: { me: SessionUser | null }) {
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [error, setError] = useState("");
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      setMembers((await fetchMembers()).members);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load members");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const changeRole = async (memberId: string, role: string) => {
    try {
      await updateMemberRole(memberId, role);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to change role");
    }
  };
  const remove = async (email: string) => {
    try {
      await removeMember(email);
      setPendingRemove(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to remove member");
    }
  };

  return (
    <>
      {error && <ErrorNote message={error} />}
      <section className="table-wrap scroll-x">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const isMe = m.user.email === me?.email;
              return (
                <tr key={m.id}>
                  <td>
                    {m.user.name}
                    {isMe && <span className="you-tag"> (you)</span>}
                  </td>
                  <td className="mono">{m.user.email}</td>
                  <td>
                    <select
                      value={m.role}
                      disabled={m.role === "owner"}
                      onChange={(e) => void changeRole(m.id, e.target.value)}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="actions-cell">
                    {m.role !== "owner" && !isMe ? (
                      pendingRemove === m.user.email ? (
                        <>
                          <button type="button" className="danger" onClick={() => void remove(m.user.email)}>
                            Confirm
                          </button>
                          <button type="button" className="ghost" onClick={() => setPendingRemove(null)}>
                            Keep
                          </button>
                        </>
                      ) : (
                        <button type="button" className="ghost" onClick={() => setPendingRemove(m.user.email)}>
                          Remove
                        </button>
                      )
                    ) : (
                      <span className="muted-dash">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}

function Invitations() {
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastLink, setLastLink] = useState<{ url: string; emailed: boolean } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      setInvitations((await fetchInvitations()).invitations);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load invitations");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await inviteMember(email.trim(), role);
      setLastLink({ url: res.accept_url, emailed: res.emailed });
      setEmail("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to send invitation");
    } finally {
      setBusy(false);
    }
  };
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked — user can select manually */
    }
  };
  const cancel = async (id: string) => {
    try {
      await cancelInvitation(id);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to cancel invitation");
    }
  };

  return (
    <>
      {error && <ErrorNote message={error} />}
      <section className="panel invite-form">
        <div className="panel-title">
          <UsersIcon /> Invite a teammate
        </div>
        <form onSubmit={(e) => void invite(e)}>
          <input
            type="email"
            placeholder="teammate@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button type="submit" disabled={busy}>
            {busy ? "Inviting…" : "Send invite"}
          </button>
        </form>
        {lastLink && (
          <div className="invite-result">
            <CheckIcon /> Invitation created{lastLink.emailed ? " and emailed" : ""}. Share this link:
            <code className="invite-link">{lastLink.url}</code>
            <button type="button" className="ghost" onClick={() => void copy(lastLink.url)}>
              <CopyIcon /> {copied === lastLink.url ? "Copied" : "Copy"}
            </button>
          </div>
        )}
      </section>
      {invitations.length > 0 ? (
        <section className="table-wrap scroll-x">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Link</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((i) => (
                <tr key={i.id}>
                  <td className="mono">{i.email}</td>
                  <td>
                    <Badge tone="muted">{i.role ?? "member"}</Badge>
                  </td>
                  <td>
                    <button type="button" className="ghost" onClick={() => void copy(i.accept_url)}>
                      <CopyIcon /> {copied === i.accept_url ? "Copied" : "Copy link"}
                    </button>
                  </td>
                  <td className="actions-cell">
                    <button type="button" className="ghost" onClick={() => void cancel(i.id)}>
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <div className="empty-state">
          <UsersIcon />
          <strong>No pending invitations</strong>
          <span>Invite a teammate above to grant them console access.</span>
        </div>
      )}
    </>
  );
}

function Account({ me }: { me: SessionUser | null }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setOk(false);
    if (next.length < 12) {
      setError("New password must be at least 12 characters.");
      return;
    }
    if (next !== confirm) {
      setError("New password and confirmation do not match.");
      return;
    }
    setBusy(true);
    try {
      await changePassword(current, next);
      setOk(true);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to change password");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="panel account-panel">
        <div className="panel-title">Signed in as</div>
        <dl className="compact-list spaced">
          <div>
            <dt>Name</dt>
            <dd>{me?.name ?? "—"}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd className="mono">{me?.email ?? "—"}</dd>
          </div>
          <div>
            <dt>Global role</dt>
            <dd>{me?.role ?? "member"}</dd>
          </div>
        </dl>
      </section>
      <section className="panel account-panel">
        <div className="panel-title">Change password</div>
        <form className="stacked-form" onSubmit={(e) => void submit(e)}>
          <label>
            Current password
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </label>
          <label>
            New password
            <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
          </label>
          <label>
            Confirm new password
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </label>
          {error && <div className="login-error"><AlertIcon />{error}</div>}
          {ok && <div className="variable-preview"><CheckIcon /> Password updated. Other sessions were signed out.</div>}
          <button type="submit" disabled={busy}>{busy ? "Updating…" : "Update password"}</button>
        </form>
      </section>
    </>
  );
}

function Organization({ canEdit }: { canEdit: boolean }) {
  const [org, setOrg] = useState<OrgSummary | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [ok, setOk] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetchOrganization();
      setOrg(res.organization);
      setName(res.organization?.name ?? "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load organization");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setOk(false);
    try {
      await updateOrganization(name.trim());
      setOk(true);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to update organization");
    }
  };

  return (
    <section className="panel account-panel">
      {error && <ErrorNote message={error} />}
      <div className="panel-title">Organization</div>
      <form className="stacked-form" onSubmit={(e) => void save(e)}>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} required />
        </label>
        <div className="compact-list spaced">
          <div>
            <dt>Slug</dt>
            <dd className="mono">{org?.slug ?? "—"}</dd>
          </div>
        </div>
        {ok && <div className="variable-preview"><CheckIcon /> Saved.</div>}
        {canEdit && <button type="submit">Save</button>}
      </form>
    </section>
  );
}

function Observability() {
  const [wh, setWh] = useState<LogWebhookSettings | null>(null);
  const [token, setToken] = useState<{ configured: boolean; updated_at: string | null } | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const [w, t] = await Promise.all([fetchLogWebhook(), fetchLogsTokenStatus()]);
      setWh(w.webhook);
      setToken(t);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load settings");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const input = (w: LogWebhookSettings) => ({
    enabled: w.enabled,
    url: w.url,
    min_level: w.min_level,
    // Send the secret only when the user changed it away from the mask.
    ...(w.secret && w.secret !== "••••••••" ? { secret: w.secret } : {}),
  });

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!wh) return;
    setSaved(false);
    setError("");
    try {
      const res = await saveLogWebhook(input(wh));
      setWh(res.webhook);
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save");
    }
  };
  const sendTest = async () => {
    if (!wh) return;
    setTest(null);
    try {
      const r = await testLogWebhook(input(wh));
      setTest(r.ok ? { ok: true, text: `Delivered (HTTP ${r.status ?? 200})` } : { ok: false, text: r.error ?? "Failed" });
    } catch (reason) {
      setTest({ ok: false, text: reason instanceof Error ? reason.message : "Failed" });
    }
  };
  const rotate = async () => {
    try {
      const r = await generateLogsToken();
      setNewToken(r.token);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to generate token");
    }
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  if (!wh || !token) {
    return error ? <ErrorNote message={error} /> : <div className="loading-state"><span className="loader" />Loading…</div>;
  }

  return (
    <>
      {error && <ErrorNote message={error} />}
      <section className="panel account-panel">
        <div className="panel-title"><AlertIcon /> Log webhook</div>
        <p className="field-hint" style={{ margin: "4px 0 0" }}>
          POST each log at or above the chosen level to your endpoint (JSON body, optionally HMAC-signed).
        </p>
        <form className="stacked-form" onSubmit={(e) => void save(e)}>
          <label className="check-label">
            <input type="checkbox" checked={wh.enabled} onChange={(e) => setWh({ ...wh, enabled: e.target.checked })} />
            Enabled
          </label>
          <label>
            Endpoint URL
            <input value={wh.url} onChange={(e) => setWh({ ...wh, url: e.target.value })} placeholder="https://logs.example.com/ingest" />
          </label>
          <label>
            Minimum level
            <select value={wh.min_level} onChange={(e) => setWh({ ...wh, min_level: e.target.value as LogLevelName })}>
              {LOG_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}{l === "warn" ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Signing secret <span className="field-hint">optional — adds X-Dispatcher-Log-Signature</span>
            <input value={wh.secret} onChange={(e) => setWh({ ...wh, secret: e.target.value })} placeholder="(none)" />
          </label>
          {saved && <div className="variable-preview"><CheckIcon /> Saved.</div>}
          {test && (
            <div className={test.ok ? "variable-preview" : "login-error"}>
              {test.ok ? <CheckIcon /> : <AlertIcon />} {test.text}
            </div>
          )}
          <div className="editor-actions">
            <button type="submit">Save</button>
            <button type="button" className="ghost" onClick={() => void sendTest()}>Send test</button>
          </div>
        </form>
      </section>

      <section className="panel account-panel">
        <div className="panel-title"><ShieldIcon /> Logs API token</div>
        <p className="field-hint" style={{ margin: "4px 0 0" }}>
          Bearer token for <code>GET /logs</code>. {token.configured ? "A token is configured." : "No token yet."}
        </p>
        {newToken && (
          <div className="invite-result">
            <CheckIcon /> New token (shown once):
            <code className="invite-link">{newToken}</code>
            <button type="button" className="ghost" onClick={() => void copy(newToken)}>
              <CopyIcon /> {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}
        <pre className="stack-trace" style={{ marginTop: 12 }}>
          curl -H "Authorization: Bearer &lt;token&gt;" \{"\n"}  "{window.location.origin}/logs?since=1h&amp;min_level=warn&amp;limit=50"
        </pre>
        <div className="editor-actions" style={{ marginTop: 12 }}>
          <button type="button" onClick={() => void rotate()}>
            {token.configured ? "Rotate token" : "Generate token"}
          </button>
        </div>
      </section>
    </>
  );
}

export default function Settings({
  user,
  refreshSignal = 0,
}: {
  user: SessionUser | null;
  refreshSignal?: number;
}) {
  const [tab, setTab] = useState<Tab>(readTab);
  useEffect(() => {
    const handler = () => setTab(readTab());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  const canManageOrg = user?.role === "admin" || user?.role === "owner";

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Manage members, invitations, your account, and the organization.</p>
        </div>
      </header>
      <div className="subtabs">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`subtab ${tab === id ? "active" : ""}`}
            onClick={() => {
              window.location.hash = `settings/${id}`;
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div key={`${tab}-${refreshSignal}`}>
        {tab === "members" && <Members me={user} />}
        {tab === "invitations" && <Invitations />}
        {tab === "account" && <Account me={user} />}
        {tab === "organization" && <Organization canEdit={canManageOrg} />}
        {tab === "observability" && <Observability />}
      </div>
    </>
  );
}
