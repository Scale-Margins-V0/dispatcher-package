import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import {
  cancelInvitation,
  changePassword,
  createApiKey as createApiKeyRequest,
  fetchApiKeys,
  fetchInvitations,
  fetchLogWebhook,
  fetchMembers,
  fetchOrganization,
  inviteMember,
  removeMember,
  revokeApiKey,
  rotateApiKey,
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
import ActionMenu from "../components/ActionMenu";
import ConfirmDialog from "../components/ConfirmDialog";
import { InfoTip } from "../components/InfoTip";
import { ActivityIcon, AlertIcon, CheckIcon, CopyIcon, ShieldIcon, UsersIcon } from "../icons";
import type {
  ApiKeyRecord,
  LogLevelName,
  LogWebhookSettings,
  OrgMember,
  OrgSummary,
  PendingInvitation,
  SessionUser,
} from "../types";

type Tab = "members" | "invitations" | "account" | "organization" | "api-keys" | "observability";
const TABS: Array<[Tab, string]> = [
  ["members", "Members"],
  ["invitations", "Invitations"],
  ["account", "Account"],
  ["organization", "Organization"],
  ["api-keys", "API keys"],
  ["observability", "Observability"],
];
const TAB_COPY: Record<Tab, { title: string; description: string }> = {
  members: { title: "Members", description: "Manage who can access this dispatcher and what they can change." },
  invitations: { title: "Invitations", description: "Invite teammates and review pending access requests." },
  account: { title: "Account", description: "Update your personal profile and sign-in credentials." },
  organization: { title: "Organization", description: "Manage the organization attached to this dispatcher." },
  "api-keys": {
    title: "API keys",
    description: "Create named bearer keys for programmatic access to dispatcher APIs.",
  },
  observability: {
    title: "Observability settings",
    description: "Choose which operational logs are forwarded to your external observability stack.",
  },
};
const ROLES = ["owner", "admin", "member"];
const LOG_LEVELS: LogLevelName[] = ["trace", "debug", "info", "warn", "error", "fatal"];
const webhookInput = (webhook: LogWebhookSettings) => ({
  enabled: webhook.enabled,
  url: webhook.url,
  levels: webhook.levels,
  ...(webhook.secret && webhook.secret !== "••••••••" ? { secret: webhook.secret } : {}),
});
const truncateApiKey = (value: string) => value.length > 20
  ? `${value.slice(0, 12)}••••••${value.slice(-6)}`
  : value;

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
              <th>Role <InfoTip label="owner: full access · admin: manage members and settings · member: view-only console access" /></th>
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
            <button type="button" className="ghost icon-button" aria-label={copied === lastLink.url ? "Invitation link copied" : "Copy invitation link"} title={copied === lastLink.url ? "Copied" : "Copy invitation link"} onClick={() => void copy(lastLink.url)}>
              {copied === lastLink.url ? <CheckIcon /> : <CopyIcon />}
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
                  <td className="actions-cell">
                    <ActionMenu label={`Actions for ${i.email}`}>
                      <button type="button" className="action-menu-item" role="menuitem" onClick={() => void copy(i.accept_url)}>
                        <CopyIcon /> Copy invitation link
                      </button>
                      <ConfirmDialog
                        trigger={
                          <button type="button" className="action-menu-item danger" role="menuitem">
                            Cancel invitation
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
                    </ActionMenu>
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
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const w = await fetchLogWebhook();
      setWh(w.webhook);
      setSavedWh(w.webhook);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load settings");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

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
      const res = await saveLogWebhook(webhookInput(wh));
      setWh(res.webhook);
      setSavedWh(res.webhook);
      setSaved(true);
      toast.success("Log webhook saved", {
        description: res.webhook.enabled
          ? `Forwarding ${res.webhook.levels.join(", ")}.`
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
      const r = await testLogWebhook(webhookInput(wh));
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
  if (!wh) {
    return error ? <ErrorNote message={error} /> : <div className="loading-state"><span className="loader" />Loading…</div>;
  }

  return (
    <div className="observability-layout single">
      {error && <ErrorNote message={error} />}
      <section className="panel observability-panel webhook-panel">
        <div className="observability-panel-head">
          <div className="settings-panel-copy">
            <div className="panel-title"><ActivityIcon /> Log webhook</div>
            <p className="panel-description">
              Forward only the selected log levels as HMAC-signable JSON.
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
          <fieldset className="log-level-fieldset">
            <legend>Forward log levels <InfoTip label="trace: all details · debug: diagnostic info · info: normal operations · warn: unexpected but handled · error: failure occurred · fatal: unrecoverable" /></legend>
            <p>Select every level the endpoint should receive.</p>
            <div className="log-level-grid">
              {LOG_LEVELS.map((level) => (
                <label className={`log-level-option level-${level}`} key={level}>
                  <input
                    type="checkbox"
                    checked={wh.levels.includes(level)}
                    onChange={() => {
                      const levels = wh.levels.includes(level)
                        ? wh.levels.filter((item) => item !== level)
                        : LOG_LEVELS.filter((item) => item === level || wh.levels.includes(item));
                      if (levels.length === 0) return;
                      setWh({ ...wh, levels });
                      setSaved(false);
                      setTest(null);
                    }}
                  />
                  <span>{level}</span>
                </label>
              ))}
            </div>
          </fieldset>
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
    </div>
  );
}

function ApiKeys() {
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      setKeys((await fetchApiKeys()).api_keys);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load API keys");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim().length < 2) return;
    setBusy(true);
    try {
      await createApiKeyRequest(name.trim());
      setName("");
      toast.success("API key created");
      await load();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Unable to create API key";
      setError(message);
      toast.error("Could not create API key", { description: message });
    } finally {
      setBusy(false);
    }
  };
  const copy = async (key: ApiKeyRecord) => {
    await navigator.clipboard.writeText(key.key);
    setCopied(key.id);
    setTimeout(() => setCopied(null), 1500);
  };
  const rotate = async (key: ApiKeyRecord) => {
    await rotateApiKey(key.id);
    toast.success(`${key.name} rotated`, { description: "The previous value stopped working immediately." });
    await load();
  };
  const revoke = async (key: ApiKeyRecord) => {
    await revokeApiKey(key.id);
    toast.success(`${key.name} revoked`);
    await load();
  };
  return (
    <div className="api-key-settings">
      {error && <ErrorNote message={error} />}
      <section className="panel api-key-create-panel">
        <div className="panel-title"><ShieldIcon /> Create API key <InfoTip label="Bearer tokens for programmatic access to dispatcher APIs. Each key gets a unique value shown once." /></div>
        <p className="panel-description">Use a distinct name for each client or environment. Values remain available to copy and are encrypted at rest.</p>
        <form className="api-key-create" onSubmit={(event) => void create(event)}>
          <label htmlFor="api-key-name">Key name</label>
          <div>
            <input id="api-key-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Production reporting" maxLength={64} />
            <button type="submit" disabled={busy || name.trim().length < 2}>{busy ? "Creating…" : "Create key"}</button>
          </div>
        </form>
      </section>
      <section className="panel api-key-list-panel">
        <div className="api-key-list-head">
          <div><div className="panel-title">Keys</div><p className="panel-description">Send a key as <code>Authorization: Bearer &lt;key&gt;</code>.</p></div>
          <Badge tone="muted">{keys.filter((key) => !key.revoked_at).length} active</Badge>
        </div>
        {keys.length === 0 ? (
          <div className="api-key-empty"><ShieldIcon /><strong>No API keys</strong><span>Create one when a service needs programmatic access.</span></div>
        ) : (
          <div className="api-key-list">
            {keys.map((key) => (
              <article className={`api-key-row ${key.revoked_at ? "revoked" : ""}`} key={key.id}>
                <div className="api-key-identity"><strong>{key.name}</strong><span>{key.revoked_at ? "Revoked" : key.last_used_at ? `Last used ${new Date(key.last_used_at).toLocaleString()}` : "Never used"}</span></div>
                <div className="api-key-value"><code>{truncateApiKey(key.key)}</code><button type="button" className="ghost icon-button" aria-label={copied === key.id ? `${key.name} copied` : `Copy ${key.name}`} title={copied === key.id ? "Copied" : "Copy API key"} disabled={Boolean(key.revoked_at)} onClick={() => void copy(key)}>{copied === key.id ? <CheckIcon /> : <CopyIcon />}</button></div>
                <div className="api-key-actions">
                  {key.revoked_at ? <Badge tone="muted">Revoked</Badge> : <ActionMenu label={`Actions for ${key.name}`}>
                    <button type="button" className="action-menu-item" role="menuitem" onClick={() => void rotate(key)}>Rotate key <InfoTip label="Generate a new key value without changing the name. Previous value stops working immediately." /></button>
                    <ConfirmDialog trigger={<button type="button" className="action-menu-item danger" role="menuitem">Revoke key <InfoTip label="Permanently disable this key. This cannot be undone." /></button>} title={`Revoke ${key.name}?`} description="Requests using this key will fail immediately." confirmLabel="Revoke key" onConfirm={() => revoke(key)} />
                  </ActionMenu>}
                </div>
              </article>
            ))}
          </div>
        )}
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
        {tab === "api-keys" && <ApiKeys />}
        {tab === "observability" && <Observability />}
      </div>
    </>
  );
}
