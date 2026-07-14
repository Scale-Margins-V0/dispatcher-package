import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { fetchActivity, fetchOverview, fetchSession, signIn, signOut } from "./api";
import { ActivityIcon, AlertIcon, BellIcon, ChatIcon, CheckIcon, ChevronIcon, ClockIcon, GridIcon, MailIcon, MessageIcon, MonitorIcon, MoonIcon, RefreshIcon, ServerIcon, ShieldIcon, SlidersIcon, SunIcon, UsersIcon } from "./icons";
import AcceptInvite from "./pages/AcceptInvite";
import Logs from "./pages/Logs";
import Settings from "./pages/Settings";
import Variables from "./pages/Variables";
import type { AdminActivity, AdminOverview, DispatchActivity, SessionUser, StatusValue, WebhookActivity } from "./types";

type Page = "overview" | "activity" | "dispatches" | "failures" | "webhooks" | "variables" | "logs" | "settings" | "runtime" | "configuration";
type Theme = "light" | "dark" | "system";
const pages = new Set<Page>(["overview", "activity", "dispatches", "failures", "webhooks", "variables", "logs", "settings", "runtime", "configuration"]);
const THEME_KEY = "dispatcher-admin-theme";
/** First hash segment (before any "/sub" or "?query"). */
const readPage = (): Page => { const value = window.location.hash.replace(/^#\/?/, "").split("?")[0].split("/")[0] as Page; return pages.has(value) ? value : "overview"; };
const readTheme = (): Theme => { const value = localStorage.getItem(THEME_KEY); return value === "light" || value === "dark" ? value : "system"; };
const formatTime = (value: string) => new Date(value).toLocaleString();
const formatUptime = (seconds: number) => { const d = Math.floor(seconds / 86400); const h = Math.floor(seconds % 86400 / 3600); const m = Math.floor(seconds % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
const tone = (status: StatusValue | string) => status === "ok" || status === "completed" || status === "delivered" ? "green" : status === "degraded" || status === "accepted" ? "amber" : "red";
const navigate = (page: Page) => { window.location.hash = page; };

function Badge({ tone: value = "muted", children }: { tone?: string; children: ReactNode }) { return <span className={`badge badge-${value}`}>{children}</span>; }
function Stat({ label, value, detail }: { label: string; value: string | number; detail?: string }) { return <article className="stat"><div className="stat-label">{label}</div><div className="stat-value">{value}</div>{detail && <div className="stat-detail">{detail}</div>}</article>; }
function Empty({ children }: { children: ReactNode }) { return <div className="empty-state"><ActivityIcon /><strong>No activity yet</strong><span>{children}</span></div>; }

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(""); try { await signIn(email, password); onSuccess(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to sign in"); } finally { setBusy(false); } };
  return <main className="login-shell"><section className="login-card"><div className="login-mark">SM</div><div className="eyebrow">Operator console</div><h1>Dispatcher access</h1><p>Sign in with your dispatcher account.</p><form onSubmit={(event) => void submit(event)}><label>Email<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required autoFocus /></label><label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>{error && <div className="login-error"><AlertIcon />{error}</div>}<button type="submit" disabled={busy}>{busy ? "Signing in…" : "Continue"}</button></form><div className="login-foot"><ShieldIcon />Protected, short-lived operator session</div></section></main>;
}

function ActivityTable({ rows }: { rows: DispatchActivity[] }) {
  if (!rows.length) return <Empty>New dispatches will appear here for the lifetime of this process.</Empty>;
  return <section className="table-wrap"><table><thead><tr><th>Campaign</th><th>Status</th><th>Channel</th><th>Recipients</th><th>Result</th><th>When</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.id}-${row.status}-${row.occurred_at}`}><td className="mono">{row.campaign_id}</td><td><Badge tone={tone(row.status)}>{row.status}</Badge></td><td>{row.channel} · {row.provider}</td><td>{row.recipient_count}</td><td>{row.sent_count === undefined ? "—" : `${row.sent_count} sent / ${row.failed_count ?? 0} failed`}</td><td>{formatTime(row.occurred_at)}</td></tr>)}</tbody></table></section>;
}
function WebhookTable({ rows }: { rows: WebhookActivity[] }) {
  if (!rows.length) return <Empty>Analytics webhook attempts will appear here without payloads or secrets.</Empty>;
  return <section className="table-wrap"><table><thead><tr><th>Destination</th><th>Status</th><th>Events</th><th>HTTP</th><th>Latency</th><th>When</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td className="mono">{row.destination ?? row.provider}</td><td><Badge tone={tone(row.status)}>{row.status}</Badge></td><td>{row.event_count}</td><td>{row.http_status ?? "—"}</td><td>{row.duration_ms === undefined ? "—" : `${row.duration_ms} ms`}</td><td>{formatTime(row.occurred_at)}</td></tr>)}</tbody></table></section>;
}

function FailuresTable({ rows }: { rows: AdminActivity["failures"] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (!rows.length) return <Empty>Failures will be grouped here when they occur.</Empty>;
  return <section className="table-wrap"><table><thead><tr><th>Source</th><th>Category</th><th>Error</th><th>Status</th><th>When</th></tr></thead><tbody>{rows.map((item) => {
    const key = `${item.id}-${item.occurred_at}`;
    const stack = "error_stack" in item ? item.error_stack : undefined;
    const hasDetail = Boolean(item.error_message || stack);
    return <>
      <tr key={key} className={hasDetail ? "log-row" : ""} onClick={() => hasDetail && setExpanded(expanded === key ? null : key)}>
        <td className="mono">{"campaign_id" in item ? item.campaign_id : item.destination ?? item.provider}</td>
        <td className="mono">{item.error_category ?? "delivery_failure"}</td>
        <td className="message-cell">{item.error_message ?? "—"}</td>
        <td><Badge tone="red">{item.status}</Badge></td>
        <td>{formatTime(item.occurred_at)}</td>
      </tr>
      {expanded === key && hasDetail && <tr key={`${key}-detail`} className="detail-row"><td colSpan={5}><div className="log-message">{item.error_message}</div>{stack && <pre className="stack-trace">{stack}</pre>}</td></tr>}
    </>;
  })}</tbody></table></section>;
}

function Overview({ overview, activity }: { overview: AdminOverview; activity: AdminActivity }) { return <><header className="page-head"><div><h1>Dispatcher overview</h1><p>Live operational state and PII-free activity since this process started.</p></div><Badge tone={tone(overview.status.status)}><span className={`dot dot-${tone(overview.status.status)}`} />{overview.status.status}</Badge></header><section className="stat-grid"><Stat label="Runtime" value={overview.status.status} detail={overview.runtime.environment} /><Stat label="Dispatched" value={activity.summary.sent} detail="Current process" /><Stat label="Failed" value={activity.summary.failed} detail="Current process" /><Stat label="Webhook success" value={activity.summary.webhook_success_rate === null ? "—" : `${activity.summary.webhook_success_rate}%`} detail="Outbound attempts" /></section><div className="section-heading"><span>System checks</span><span className="section-line" /></div><section className="panel check-list">{Object.entries(overview.status.checks).map(([name, check]) => <div className="check-row" key={name}><div className={`status-icon ${check.ok ? "ok" : "error"}`}>{check.ok ? <CheckIcon /> : <AlertIcon />}</div><div className="check-copy"><div className="check-name">{name.replaceAll("_", " ")}</div><div className="check-message">{check.message ?? "Configured and responding normally"}</div></div><Badge tone={check.ok ? "green" : "red"}>{check.ok ? "healthy" : "attention"}</Badge></div>)}</section><div className="section-heading"><span>Recent dispatches</span><span className="section-line" /></div><ActivityTable rows={activity.dispatches.slice(0, 5)} /></>; }

function Runtime({ data }: { data: AdminOverview }) { const rows = [["Version", data.build.version], ["Git SHA", data.build.git_sha], ["Build time", data.build.build_time], ["Image", data.build.image_tag], ["Node", data.runtime.node_version], ["Environment", data.runtime.environment]]; return <><header className="page-head"><div><h1>Runtime</h1><p>Build identity and process lifecycle for rollout verification.</p></div></header><section className="hero-panel panel-accent"><div className={`hero-mark ${tone(data.status.status)}`}><ActivityIcon /></div><div><div className="eyebrow">Current process</div><h2>{data.status.status === "ok" ? "Running normally" : "Needs attention"}</h2><p>Started {formatUptime(data.runtime.uptime_seconds)} ago</p></div></section><div className="section-heading"><span>Build identity</span><span className="section-line" /></div><section className="table-wrap"><table><tbody>{rows.map(([label, value]) => <tr key={label}><th>{label}</th><td className="mono">{value || "unknown"}</td></tr>)}</tbody></table></section></>; }
type ProviderInfo = AdminOverview["config"]["providers"][number];
type ChannelDef = { id: string; label: string; icon: ReactNode; badge?: string; badgeKind?: "beta" | "soon"; comingSoon?: boolean };
const CHANNELS: ChannelDef[] = [
  { id: "email", label: "Email", icon: <MailIcon /> },
  { id: "whatsapp", label: "WhatsApp", icon: <ChatIcon />, badge: "Beta", badgeKind: "beta" },
  { id: "sms", label: "SMS", icon: <MessageIcon />, badge: "Coming soon", badgeKind: "soon", comingSoon: true },
  { id: "push", label: "Push", icon: <BellIcon />, badge: "Coming soon", badgeKind: "soon", comingSoon: true },
];
const cap = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

function ProviderAccordionItem({ provider, open, onToggle }: { provider: ProviderInfo; open: boolean; onToggle: () => void }) {
  const stateTone = provider.state === "active" || provider.state === "ready" ? "green" : provider.state === "incomplete" ? "amber" : "muted";
  return <div className={`accordion-item ${open ? "open" : ""}`}>
    <button type="button" className="accordion-head" onClick={onToggle}>
      <span className="accordion-title">{cap(provider.provider)}</span>
      <span className="accordion-meta"><Badge tone={stateTone}>{provider.state.replaceAll("_", " ")}</Badge><ChevronIcon className="accordion-chevron" /></span>
    </button>
    {open && <div className="accordion-body">
      <div className="provider-sets">{provider.credential_sets.map((set) => <div className="provider-set" key={set.label}><div className="provider-set-label"><span className={`dot ${set.satisfied ? "dot-green" : "dot-amber"}`} />{set.label}<Badge tone={set.satisfied ? "green" : "amber"}>{set.satisfied ? "ready" : "missing"}</Badge></div><div className="provider-envs">{Object.entries(set.variables).map(([name, present]) => <span className={`provider-env ${present ? "present" : "absent"}`} key={name}>{name}</span>)}</div></div>)}</div>
      {provider.webhook && <div className="provider-webhook"><span>Webhook</span><Badge tone={provider.webhook.enabled ? "green" : "muted"}>{provider.webhook.enabled ? "enabled" : "off"}</Badge>{provider.webhook.verification_configured && <span className="verified"><CheckIcon />verification set</span>}</div>}
    </div>}
  </div>;
}

function ProvidersPanel({ providers }: { providers: ProviderInfo[] }) {
  const [channel, setChannel] = useState<string>("email");
  const keyOf = (p: ProviderInfo) => `${p.channel}-${p.provider}`;
  const [openKey, setOpenKey] = useState<string | null>(providers[0] ? keyOf(providers[0]) : null);
  const meta = CHANNELS.find((c) => c.id === channel) ?? CHANNELS[0];
  const list = providers.filter((p) => p.channel === channel);
  const selectChannel = (id: string) => { setChannel(id); const first = providers.find((p) => p.channel === id); setOpenKey(first ? keyOf(first) : null); };
  return <section className="providers-block">
    <div className="channel-tabs">{CHANNELS.map((c) => { const count = providers.filter((p) => p.channel === c.id).length; return <button key={c.id} type="button" className={`channel-tab ${channel === c.id ? "active" : ""}`} onClick={() => selectChannel(c.id)}>{c.icon}<span>{c.label}</span>{c.badge && <span className={`mini-badge ${c.badgeKind}`}>{c.badge}</span>}{!c.comingSoon && count > 0 && <span className="tab-count">{count}</span>}</button>; })}</div>
    {meta.comingSoon
      ? <div className="coming-soon">{meta.icon}<strong>{meta.label} delivery is coming soon</strong><span>Support for {meta.label} is on the roadmap. Email and WhatsApp are available today.</span></div>
      : list.length === 0
        ? <div className="empty-state">{meta.icon}<strong>No {meta.label.toLowerCase()} providers configured</strong><span>Set the provider credentials in your environment to enable {meta.label.toLowerCase()} delivery.</span></div>
        : <div className="accordion">{list.map((p) => <ProviderAccordionItem key={keyOf(p)} provider={p} open={openKey === keyOf(p)} onToggle={() => setOpenKey(openKey === keyOf(p) ? null : keyOf(p))} />)}</div>}
  </section>;
}

function Configuration({ data }: { data: AdminOverview }) { return <><header className="page-head"><div><h1>Configuration</h1><p>Provider readiness is checked locally from redacted configuration. Secrets never leave the process.</p></div></header><section className="split-grid"><article className="panel"><div className="panel-title"><SlidersIcon /> Delivery</div><dl className="compact-list spaced"><div><dt>Selected email provider</dt><dd>{data.config.email_provider}</dd></div><div><dt>Lookup backend</dt><dd>{data.config.user_lookup_backend ?? "unknown"}</dd></div><div><dt>Forward mode</dt><dd>{data.config.events?.forward_mode ?? "unknown"}</dd></div><div><dt>Buffer</dt><dd>{data.config.events?.buffer_kind ?? "unknown"}</dd></div></dl></article><article className="panel"><div className="panel-title"><ShieldIcon /> Platform secrets</div><div className="credential-list">{Object.entries(data.env.required).map(([name, present]) => <div key={name}><span className={`dot ${present ? "dot-green" : "dot-red"}`} /><code>{name}</code><Badge tone={present ? "green" : "red"}>{present ? "set" : "missing"}</Badge></div>)}</div></article></section><div className="section-heading"><span>Channels &amp; providers</span><span className="section-line" /></div><ProvidersPanel providers={data.config.providers} /><div className="section-heading"><span>Personalization placeholders</span><span className="section-line" /><span className="section-count">{data.config.placeholder_names.length}</span></div><section className="panel"><div className="chip-row">{data.config.placeholder_names.map((name) => <span className="chip" key={name}>{`{{${name}}}`}</span>)}</div></section></>; }

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null); const [sessionUser, setSessionUser] = useState<SessionUser | null>(null); const [page, setPage] = useState<Page>(readPage); const [theme, setTheme] = useState<Theme>(readTheme); const [overview, setOverview] = useState<AdminOverview | null>(null); const [activity, setActivity] = useState<AdminActivity | null>(null); const [error, setError] = useState(""); const [loading, setLoading] = useState(false); const [refreshSignal, setRefreshSignal] = useState(0);
  const load = useCallback(async () => { setLoading(true); setError(""); setRefreshSignal((n) => n + 1); try { const [nextOverview, nextActivity] = await Promise.all([fetchOverview(), fetchActivity()]); setOverview(nextOverview); setActivity(nextActivity); } catch (reason) { if (reason instanceof Error && reason.message.includes("Authentication")) setAuthenticated(false); else setError(reason instanceof Error ? reason.message : "Unable to connect"); } finally { setLoading(false); } }, []);
  useEffect(() => { void fetchSession().then((session) => { setAuthenticated(session.authenticated); setSessionUser(session.user ?? null); }).catch(() => setAuthenticated(false)); }, []);
  useEffect(() => { if (authenticated) void load(); }, [authenticated, load]);
  useEffect(() => { const handler = () => setPage(readPage()); window.addEventListener("hashchange", handler); return () => window.removeEventListener("hashchange", handler); }, []);
  useEffect(() => { if (theme === "system") { document.documentElement.removeAttribute("data-theme"); localStorage.removeItem(THEME_KEY); } else { document.documentElement.dataset.theme = theme; localStorage.setItem(THEME_KEY, theme); } }, [theme]);
  // Invite acceptance is reachable without an existing session.
  if (window.location.hash.replace(/^#\/?/, "").startsWith("settings/accept")) return <AcceptInvite />;
  if (authenticated === null) return <div className="loading-state"><span className="loader" />Checking access…</div>;
  if (!authenticated) return <Login onSuccess={() => { setAuthenticated(true); void fetchSession().then((s) => setSessionUser(s.user ?? null)); }} />;
  const nav: Array<[Page, string, ReactNode]> = [["overview", "Overview", <GridIcon />], ["activity", "Delivery activity", <ActivityIcon />], ["dispatches", "Dispatches", <ServerIcon />], ["failures", "Failures", <AlertIcon />], ["webhooks", "Webhooks", <ClockIcon />], ["variables", "Variables", <SlidersIcon />], ["logs", "Logs", <ClockIcon />], ["settings", "Settings", <UsersIcon />], ["runtime", "Runtime", <MonitorIcon />], ["configuration", "Configuration", <SlidersIcon />]];
  const cycleTheme = () => setTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light"); const ThemeIcon = theme === "light" ? SunIcon : theme === "dark" ? MoonIcon : MonitorIcon;
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark">SM</div><span className="brand-name">dispatcher</span>{overview && <span className="version">v{overview.build.version}</span>}</div><nav>{nav.map(([id, label, icon]) => <button key={id} type="button" className={`nav-item ${page === id ? "active" : ""}`} onClick={() => navigate(id)}>{icon}{label}</button>)}</nav><div className="sidebar-footer"><div className="access-state"><ShieldIcon /><span><strong>Protected access</strong><small>Operator console</small></span></div><button type="button" className="footer-action" onClick={cycleTheme}><ThemeIcon /> <span>{theme} theme</span></button><button type="button" className="footer-action" onClick={() => void signOut().finally(() => { setSessionUser(null); setAuthenticated(false); })}><ShieldIcon /> <span>Sign out</span></button></div></aside><main className="main"><div className="main-inner"><div className="topbar"><div className="environment"><span className={`dot dot-${overview ? tone(overview.status.status) : "muted"}`} />{overview?.runtime.environment ?? "connecting"}</div><button type="button" className="refresh-button" onClick={() => void load()} disabled={loading}><RefreshIcon className={loading ? "spin" : ""} />Refresh</button></div>{error && <div className="error-state"><AlertIcon /><strong>Cannot load dispatcher state</strong><p>{error}</p></div>}{overview && activity && page === "overview" && <Overview overview={overview} activity={activity} />}{activity && page === "activity" && <><header className="page-head"><div><h1>Delivery activity</h1><p>Delivery totals persisted in the dispatcher state database — they survive restarts.</p></div></header><section className="stat-grid"><Stat label="Accepted" value={activity.summary.accepted_dispatches} /><Stat label="Completed" value={activity.summary.completed_dispatches} /><Stat label="Sent" value={activity.summary.sent} /><Stat label="Failed" value={activity.summary.failed} /></section><ActivityTable rows={activity.dispatches} /></>}{activity && page === "dispatches" && <><header className="page-head"><div><h1>Recent dispatches</h1><p>Campaign-level activity only. Recipient identifiers and message content are never shown.</p></div></header><ActivityTable rows={activity.dispatches} /></>}{activity && page === "failures" && <><header className="page-head"><div><h1>Failures</h1><p>Real failure detail from dispatch processing and webhook delivery — click a row for the full error and stack trace.</p></div></header><FailuresTable rows={activity.failures} /></>}{page === "variables" && <Variables refreshSignal={refreshSignal} />}{page === "logs" && <Logs refreshSignal={refreshSignal} />}{page === "settings" && <Settings user={sessionUser} refreshSignal={refreshSignal} />}{activity && page === "webhooks" && <><header className="page-head"><div><h1>Webhook activity</h1><p>Sanitized outbound analytics attempts, HTTP status, latency, and retry attempt.</p></div></header><WebhookTable rows={activity.webhooks} /></>}{overview && page === "runtime" && <Runtime data={overview} />}{overview && page === "configuration" && <Configuration data={overview} />}{activity && page !== "settings" && <footer className="page-footer"><ClockIcon />Activity persisted in the dispatcher state database · process up since {formatTime(activity.scope.started_at)}</footer>}</div></main></div>;
}
