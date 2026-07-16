import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import ConfirmDialog from "../components/ConfirmDialog";
import { ActivityIcon, AlertIcon, CheckIcon, CopyIcon, ShieldIcon, UsersIcon } from "../icons";
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
const TAB_COPY: Record<Tab, { title: string; description: string }> = {
  members: { title: "Members", description: "Manage who can access this dispatcher and what they can change." },
  invitations: { title: "Invitations", description: "Invite teammates and review pending access requests." },
  account: { title: "Account", description: "Update your personal profile and sign-in credentials." },
  organization: { title: "Organization", description: "Manage the organization attached to this dispatcher." },
  observability: {
    title: "Observability settings",
    description: "Route operational logs to your stack and control programmatic access to the logs API.",
  },
};
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
      toast.success(`Role changed to ${role}`);
      await load();
    } catch (reason) {
      const m = reason instanceof Error ? reason.message : undefined;
      setError(m ?? "Unable to change role");
      toast.error("Could not change role", { description: m });
    }
  };
  const remove = async (email: string) => {
    try {
      await removeMember(email);
      toast.success(`${email} removed from the organization`);
      await load();
    } catch (reason) {
      const m = reason instanceof Error ? reason.message : undefined;
      setError(m ?? "Unable to remove member");
      toast.error("Could not remove member", { description: m });
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
                    <Select
                      value={m.role}
                      disabled={m.role === "owner"}
                      onValueChange={(value) => void changeRole(m.id, value)}
                    >
                      <SelectTrigger className="w-[130px]" aria-label="Member role">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLES.map((r) => (
                          <SelectItem key={r} value={r}>
                            {r}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="actions-cell">
                    {m.role !== "owner" && !isMe ? (
                      <ConfirmDialog
                        trigger={
                          <button type="button" className="ghost">
                            Remove
                          </button>
                        }
                        title={`Remove ${m.user.name}?`}
                        description={
                          <>
                            <strong>{m.user.email}</strong> will immediately lose access to this
                            dispatcher. You can invite them again later.
                          </>
                        }
                        confirmLabel="Remove member"
                        onConfirm={() => remove(m.user.email)}
                      />
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
      const invited = email.trim();
      const res = await inviteMember(invited, role);
      setLastLink({ url: res.accept_url, emailed: res.emailed });
      setEmail("");
      toast.success(`Invitation created for ${invited}`, {
        description: res.emailed ? "Emailed, and the link is below." : "Copy the link below to share it.",
      });
      await load();
    } catch (reason) {
      const m = reason instanceof Error ? reason.message : undefined;
      setError(m ?? "Unable to send invitation");
      toast.error("Could not send invitation", { description: m });
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
      toast.success("Invitation cancelled");
      await load();
    } catch (reason) {
      const m = reason instanceof Error ? reason.message : undefined;
      setError(m ?? "Unable to cancel invitation");
      toast.error("Could not cancel invitation", { description: m });
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
          <Select value={role} onValueChange={setRole}>
            <SelectTrigger className="w-[130px]" aria-label="Invite role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
                    <ConfirmDialog
                      trigger={
                        <button type="button" className="ghost">
                          Cancel
                        </button>
                      }
                      title="Cancel this invitation?"
                      description={
                        <>
                          The link sent to <strong>{i.email}</strong> will stop working. You can send
                          a fresh invitation at any time.
                        </>
                      }
                      confirmLabel="Cancel invitation"
                      onConfirm={() => cancel(i.id)}
                    />
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
      toast.success("Password updated", { description: "Other sessions were signed out." });
    } catch (reason) {
      const m = reason instanceof Error ? reason.message : undefined;
      setError(m ?? "Unable to change password");
      toast.error("Could not change password", { description: m });
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
      toast.success("Organization updated");
      await load();
    } catch (reason) {
      const m = reason instanceof Error ? reason.message : undefined;
      setError(m ?? "Unable to update organization");
      toast.error("Could not update organization", { description: m });
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
  const [savedWh, setSavedWh] = useState<LogWebhookSettings | null>(null);
  const [token, setToken] = useState<{ configured: boolean; updated_at: string | null } | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState<"token" | "command" | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [rotating, setRotating] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const [w, t] = await Promise.all([fetchLogWebhook(), fetchLogsTokenStatus()]);
      setWh(w.webhook);
      setSavedWh(w.webhook);
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

  const webhookChanged = Boolean(wh && savedWh && JSON.stringify(wh) !== JSON.stringify(savedWh));
  const endpointValid = Boolean(wh?.url.trim() && (() => {
    try {
      const url = new URL(wh?.url.trim() ?? "");
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  })());
  const endpointError = Boolean(wh?.enabled && wh.url.trim() && !endpointValid);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!wh) return;
    setSaved(false);
    setError("");
    setSaving(true);
    try {
      const res = await saveLogWebhook(input(wh));
      setWh(res.webhook);
      setSavedWh(res.webhook);
      setSaved(true);
      toast.success("Log webhook saved", {
        description: res.webhook.enabled
          ? `Forwarding ${res.webhook.min_level} and above.`
          : "Currently disabled.",
      });
    } catch (reason) {
      const m = reason instanceof Error ? reason.message : undefined;
      setError(m ?? "Unable to save");
      toast.error("Could not save the webhook", { description: m });
    } finally {
      setSaving(false);
    }
  };
  const sendTest = async () => {
    if (!wh) return;
    setTest(null);
    setTesting(true);
    try {
      const r = await testLogWebhook(input(wh));
      setTest(r.ok ? { ok: true, text: `Delivered (HTTP ${r.status ?? 200})` } : { ok: false, text: r.error ?? "Failed" });
      if (r.ok) toast.success("Test event delivered", { description: `HTTP ${r.status ?? 200}` });
      else toast.error("Test delivery failed", { description: r.error });
    } catch (reason) {
      const m = reason instanceof Error ? reason.message : "Failed";
      setTest({ ok: false, text: m });
      toast.error("Test delivery failed", { description: m });
    } finally {
      setTesting(false);
    }
  };
  const rotate = async () => {
    setRotating(true);
    try {
      const r = await generateLogsToken();
      setNewToken(r.token);
      toast.success("Logs API token generated", {
        description: "Shown once — copy it now. Any previous token stopped working.",
      });
      await load();
    } catch (reason) {
      const m = reason instanceof Error ? reason.message : undefined;
      setError(m ?? "Unable to generate token");
      toast.error("Could not generate token", { description: m });
    } finally {
      setRotating(false);
    }
  };
  const copy = async (text: string, target: "token" | "command") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(target);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  if (!wh || !token) {
    return error ? <ErrorNote message={error} /> : <div className="loading-state"><span className="loader" />Loading…</div>;
  }

  const curlCommand = newToken
    ? `curl -H "Authorization: Bearer ${newToken}" \\\n+  "${window.location.origin}/logs?since=1h&min_level=warn&limit=50"`
    : "";

  return (
    <div className="observability-layout">
      {error && <ErrorNote message={error} />}
      <section className="panel observability-panel webhook-panel">
        <div className="observability-panel-head">
          <div className="settings-panel-copy">
            <div className="panel-title"><ActivityIcon /> Log webhook</div>
            <p className="panel-description">
              Forward logs at or above the selected level as HMAC-signable JSON.
            </p>
          </div>
          <label className="webhook-toggle" htmlFor="log-webhook-enabled">
            <span>{wh.enabled ? "On" : "Off"}</span>
            <Switch
              id="log-webhook-enabled"
              checked={wh.enabled}
              onCheckedChange={(enabled) => {
                setWh({ ...wh, enabled });
                setSaved(false);
                setTest(null);
              }}
              aria-label="Enable log webhook"
            />
          </label>
        </div>
        <form className="stacked-form" onSubmit={(e) => void save(e)}>
          <label>
            Endpoint URL
            <input
              value={wh.url}
              onChange={(e) => {
                setWh({ ...wh, url: e.target.value });
                setSaved(false);
                setTest(null);
              }}
              placeholder="https://logs.example.com/ingest"
              inputMode="url"
              aria-invalid={endpointError}
              aria-describedby="endpoint-help"
            />
            <span id="endpoint-help" className={endpointError ? "field-message error" : "field-message"}>
              {endpointError ? "Enter a complete HTTP or HTTPS endpoint." : "The dispatcher sends an HTTP POST request to this URL."}
            </span>
          </label>
          <label>
            Minimum level
            <Select
              value={wh.min_level}
              onValueChange={(value) => {
                setWh({ ...wh, min_level: value as LogLevelName });
                setSaved(false);
                setTest(null);
              }}
            >
              <SelectTrigger aria-label="Minimum log level">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOG_LEVELS.map((l) => (
                  <SelectItem key={l} value={l}>
                    {l}
                    {l === "warn" ? " (default)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label>
            Signing secret <span className="optional-label">Optional</span>
            <input
              type="password"
              autoComplete="new-password"
              value={wh.secret}
              onChange={(e) => {
                setWh({ ...wh, secret: e.target.value });
                setSaved(false);
                setTest(null);
              }}
              placeholder="Enter a secret"
            />
            <span className="field-message">
              Adds an <code>X-Dispatcher-Log-Signature</code> header to every request.
            </span>
          </label>
          {saved && <div className="variable-preview"><CheckIcon /> Saved.</div>}
          {test && (
            <div className={test.ok ? "variable-preview" : "login-error"}>
              {test.ok ? <CheckIcon /> : <AlertIcon />} {test.text}
            </div>
          )}
          <div className="editor-actions">
            <button
              type="submit"
              disabled={!webhookChanged || saving || (wh.enabled && !endpointValid)}
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={!endpointValid || testing}
              aria-describedby={!endpointValid ? "send-test-help" : undefined}
              onClick={() => void sendTest()}
            >
              {testing ? "Sending…" : "Send test"}
            </button>
          </div>
          {!endpointValid && (
            <p id="send-test-help" className="action-help">Add a valid endpoint URL to send a test event.</p>
          )}
        </form>
      </section>

      <section className="panel observability-panel token-panel">
        <div className="observability-panel-head token-heading">
          <div className="settings-panel-copy">
            <div className="panel-title"><ShieldIcon /> Logs API token</div>
            <p className="panel-description">Authenticate requests to <code>GET /logs</code>.</p>
          </div>
          <span className={`token-status ${token.configured ? "configured" : "empty"}`}>
            <span className="dot" />{token.configured ? "Configured" : "Not configured"}
          </span>
        </div>
        {newToken && (
          <div className="token-reveal" role="status">
            <div className="token-reveal-head">
              <span><CheckIcon /> New token</span>
              <strong>Shown once</strong>
            </div>
            <p>Copy this token now. You will not be able to retrieve it again.</p>
            <div className="copy-field">
              <code>{newToken}</code>
              <button type="button" className="ghost" onClick={() => void copy(newToken, "token")}>
                <CopyIcon /> {copied === "token" ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="code-block-wrap">
              <pre className="stack-trace">{curlCommand}</pre>
              <button type="button" className="ghost code-copy" onClick={() => void copy(curlCommand, "command")}>
                <CopyIcon /> {copied === "command" ? "Copied" : "Copy command"}
              </button>
            </div>
          </div>
        )}
        {!newToken && (
          <div className="token-empty-state">
            <ShieldIcon />
            <strong>{token.configured ? "A token is active" : "No API token yet"}</strong>
            <p>
              {token.configured
                ? "For security, the existing token cannot be displayed. Rotate it only if you can update every client using it."
                : "Generate a bearer token when an external tool needs access to dispatcher logs."}
            </p>
            {token.configured && token.updated_at && (
              <span>Last rotated {new Date(token.updated_at).toLocaleString()}</span>
            )}
          </div>
        )}
        <div className="editor-actions token-actions">
          <button
            type="button"
            className={token.configured ? "ghost" : undefined}
            disabled={rotating}
            onClick={() => void rotate()}
          >
            {rotating ? "Generating…" : token.configured ? "Rotate token" : "Generate token"}
          </button>
          {token.configured && !newToken && (
            <span className="action-help">Rotation immediately invalidates the current token.</span>
          )}
        </div>
      </section>
    </div>
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
  const pageCopy = TAB_COPY[tab];

  return (
    <>
      <header className="page-head">
        <div>
          <h1>{pageCopy.title}</h1>
          <p>{pageCopy.description}</p>
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
