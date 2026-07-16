import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { fetchActivity, fetchOverview, fetchPlatformSecrets, fetchSession, signIn, signOut } from "./api";
import { InfoTip } from "./components/InfoTip";
import { ActivityIcon, AlertIcon, BellIcon, ChatIcon, CheckIcon, ChevronIcon, ClockIcon, CopyIcon, ExternalLinkIcon, GridIcon, MailIcon, MessageIcon, MonitorIcon, MoonIcon, RefreshIcon, ServerIcon, ShieldIcon, SidebarIcon, SlidersIcon, SunIcon, UsersIcon } from "./icons";
import { PROVIDER_DOCS, ProviderLogo } from "./logos";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import AcceptInvite from "./pages/AcceptInvite";
import Campaigns, { campaignHash } from "./pages/Campaigns";
import Logs from "./pages/Logs";
import Settings from "./pages/Settings";
import Variables from "./pages/Variables";
import type { AdminActivity, AdminOverview, DispatchActivity, SessionUser, StatusValue } from "./types";

type Page = "overview" | "campaigns" | "variables" | "logs" | "settings" | "runtime" | "configuration";
type Theme = "light" | "dark" | "system";
const pages = new Set<Page>(["overview", "campaigns", "variables", "logs", "settings", "runtime", "configuration"]);
/** Pre-console routes fold into the unified campaign console. */
const LEGACY_PAGES: Record<string, Page> = { activity: "campaigns", dispatches: "campaigns", failures: "campaigns", webhooks: "campaigns" };
const THEME_KEY = "dispatcher-admin-theme";
const SIDEBAR_KEY = "dispatcher-admin-sidebar-collapsed";
/** First hash segment (before any "/sub" or "?query"). */
const readPage = (): Page => {
  const value = window.location.hash.replace(/^#\/?/, "").split("?")[0].split("/")[0];
  if (value in LEGACY_PAGES) return LEGACY_PAGES[value];
  return pages.has(value as Page) ? (value as Page) : "overview";
};
const readTheme = (): Theme => { const value = localStorage.getItem(THEME_KEY); return value === "light" || value === "dark" ? value : "system"; };
const formatTime = (value: string) => new Date(value).toLocaleString();
const formatUptime = (seconds: number) => { const d = Math.floor(seconds / 86400); const h = Math.floor(seconds % 86400 / 3600); const m = Math.floor(seconds % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
const tone = (status: StatusValue | string) => status === "ok" || status === "completed" || status === "delivered" ? "green" : status === "degraded" || status === "accepted" ? "amber" : "red";
const navigate = (page: Page) => { window.location.hash = page; };
const NAV: Array<[Page, string, ReactNode]> = [["overview", "Overview", <GridIcon />], ["campaigns", "Campaigns", <ServerIcon />], ["variables", "Variables", <SlidersIcon />], ["logs", "Logs", <ClockIcon />], ["settings", "Settings", <UsersIcon />], ["runtime", "Runtime", <MonitorIcon />], ["configuration", "Configuration", <SlidersIcon />]];
const providerKey = (provider: ProviderInfo) => `${provider.channel}-${provider.provider}`;
const truncateSecret = (value: string) => value.length > 18 ? `${value.slice(0, 8)}••••••${value.slice(-6)}` : value;

function Badge({ tone: value = "muted", children }: { tone?: string; children: ReactNode }) { return <span className={`badge badge-${value}`}>{children}</span>; }
function Stat({ label, value, detail }: { label: string; value: string | number; detail?: string }) { return <article className="stat"><div className="stat-label">{label}</div><div className="stat-value">{value}</div>{detail && <div className="stat-detail">{detail}</div>}</article>; }
function Empty({ children }: { children: ReactNode }) { return <div className="empty-state"><ActivityIcon /><strong>No activity yet</strong><span>{children}</span></div>; }

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(""); try { await signIn(email, password); onSuccess(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to sign in"); } finally { setBusy(false); } };
  return <main className="login-shell"><section className="login-card"><div className="login-mark">SM</div><div className="eyebrow">Operator console</div><h1>Dispatcher access</h1><p>Sign in with your dispatcher account.</p><form onSubmit={(event) => void submit(event)}><label>Email<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required autoFocus /></label><label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>{error && <div className="login-error"><AlertIcon />{error}</div>}<button type="submit" disabled={busy}>{busy ? "Signing in…" : "Continue"}</button></form><div className="login-foot"><ShieldIcon />Protected, short-lived operator session</div></section></main>;
}

/** Overview strip: latest runs, each linking into the campaign console. */
function RecentDispatches({ rows }: { rows: DispatchActivity[] }) {
  if (!rows.length) return <Empty>New dispatches will appear here for the lifetime of this process.</Empty>;
  return <section className="table-wrap"><table><thead><tr><th>Campaign</th><th>Status</th><th>Channel</th><th>Recipients</th><th>Result</th><th>When</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.id}-${row.status}-${row.occurred_at}`} className="log-row" onClick={() => { window.location.hash = campaignHash(row.campaign_id); }}><td><button type="button" className="campaign-link">{row.campaign_id}</button></td><td><Badge tone={tone(row.status)}>{row.status}</Badge></td><td>{row.channel} · {row.provider}</td><td>{row.recipient_count}</td><td>{row.sent_count === undefined ? "—" : `${row.sent_count} sent / ${row.failed_count ?? 0} failed`}</td><td>{formatTime(row.occurred_at)}</td></tr>)}</tbody></table></section>;
}

function Overview({ overview, activity }: { overview: AdminOverview; activity: AdminActivity }) { return <><header className="page-head"><div><h1>Dispatcher overview</h1><p>Live operational state and PII-free activity since this process started.</p></div><Badge tone={tone(overview.status.status)}><span className={`dot dot-${tone(overview.status.status)}`} />{overview.status.status}</Badge></header><section className="stat-grid"><Stat label="Runtime" value={overview.status.status} detail={overview.runtime.environment} /><Stat label="Dispatched" value={activity.summary.sent} detail="Current process" /><Stat label="Failed" value={activity.summary.failed} detail="Current process" /><Stat label="Webhook success" value={activity.summary.webhook_success_rate === null ? "—" : `${activity.summary.webhook_success_rate}%`} detail="Outbound attempts" /></section><div className="section-heading"><span>System checks</span><span className="section-line" /></div><section className="panel check-list">{Object.entries(overview.status.checks).map(([name, check]) => <div className="check-row" key={name}><div className={`status-icon ${check.ok ? "ok" : "error"}`}>{check.ok ? <CheckIcon /> : <AlertIcon />}</div><div className="check-copy"><div className="check-name">{name.replaceAll("_", " ")}</div><div className="check-message">{check.message ?? "Configured and responding normally"}</div></div><Badge tone={check.ok ? "green" : "red"}>{check.ok ? "healthy" : "attention"}</Badge></div>)}</section><div className="section-heading"><span>Recent dispatches</span><span className="section-line" /></div><RecentDispatches rows={activity.dispatches.slice(0, 5)} /></>; }

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
  const docs = PROVIDER_DOCS[provider.provider.toLowerCase()];
  return <div className={`accordion-item ${open ? "open" : ""}`}>
    <button type="button" className="accordion-head" onClick={onToggle}>
      <span className="accordion-title"><ProviderLogo provider={provider.provider} />{cap(provider.provider)}</span>
      <span className="accordion-meta"><Badge tone={stateTone}>{provider.state.replaceAll("_", " ")}</Badge><InfoTip label="active: delivering · ready: configured and idle · incomplete: missing credentials · not configured" /><ChevronIcon className="accordion-chevron" /></span>
    </button>
    {open && <div className="accordion-body">
      <div className="provider-sets">{provider.credential_sets.map((set) => <div className="provider-set" key={set.label}><div className="provider-set-label"><span className={`dot ${set.satisfied ? "dot-green" : "dot-amber"}`} />{set.label}<Badge tone={set.satisfied ? "green" : "amber"}>{set.satisfied ? "ready" : "missing"}</Badge></div><div className="provider-envs">{Object.entries(set.variables).map(([name, present]) => <span className={`provider-env ${present ? "present" : "absent"}`} key={name}>{name}</span>)}</div></div>)}</div>
      {provider.webhook && <div className="provider-webhook"><span>Webhook</span><Badge tone={provider.webhook.enabled ? "green" : "muted"}>{provider.webhook.enabled ? "enabled" : "off"}</Badge>{provider.webhook.verification_configured && <span className="verified"><CheckIcon />verification set</span>}</div>}
      {docs && <a className="provider-docs" href={docs.url} target="_blank" rel="noreferrer noopener"><ExternalLinkIcon />{docs.label}</a>}
    </div>}
  </div>;
}

function ProvidersPanel({ providers }: { providers: ProviderInfo[] }) {
  const [channel, setChannel] = useState<string>("email");
  const [openKey, setOpenKey] = useState<string | null>(providers[0] ? providerKey(providers[0]) : null);
  const meta = CHANNELS.find((c) => c.id === channel) ?? CHANNELS[0];
  const list = providers.filter((p) => p.channel === channel);
  const selectChannel = (id: string) => { setChannel(id); const first = providers.find((p) => p.channel === id); setOpenKey(first ? providerKey(first) : null); };
  return <section className="providers-block">
    <div className="channel-tabs">{CHANNELS.map((c) => { const count = providers.filter((p) => p.channel === c.id).length; return <button key={c.id} type="button" className={`channel-tab ${channel === c.id ? "active" : ""}`} onClick={() => selectChannel(c.id)}>{c.icon}<span>{c.label}</span>{c.badge && <span className={`mini-badge ${c.badgeKind}`}>{c.badge}</span>}{!c.comingSoon && count > 0 && <span className="tab-count">{count}</span>}</button>; })}</div>
    {meta.comingSoon
      ? <div className="coming-soon">{meta.icon}<strong>{meta.label} delivery is coming soon</strong><span>Support for {meta.label} is on the roadmap. Email and WhatsApp are available today.</span></div>
      : list.length === 0
        ? <div className="empty-state">{meta.icon}<strong>No {meta.label.toLowerCase()} providers configured</strong><span>Set the provider credentials in your environment to enable {meta.label.toLowerCase()} delivery.</span></div>
        : <div className="accordion">{list.map((p) => <ProviderAccordionItem key={providerKey(p)} provider={p} open={openKey === providerKey(p)} onToggle={() => setOpenKey(openKey === providerKey(p) ? null : providerKey(p))} />)}</div>}
  </section>;
}

function PlatformSecrets() {
  const [secrets, setSecrets] = useState<Array<{ name: string; value: string }>>([]);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => { void fetchPlatformSecrets().then((result) => setSecrets(result.secrets)); }, []);
  const copy = async (name: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(name);
    setTimeout(() => setCopied(null), 1500);
  };
  return <article className="panel"><div className="panel-title"><ShieldIcon /> Platform secrets</div><p className="panel-description">Values are truncated on screen. Copy sends the complete value to your clipboard.</p><div className="credential-list secret-list">{secrets.map(({ name, value }) => <div key={name}><span className={`dot ${value ? "dot-green" : "dot-red"}`} /><span className="secret-copy"><code>{name}</code><code>{value ? truncateSecret(value) : "Not configured"}</code></span>{value ? <button type="button" className="ghost icon-button" aria-label={copied === name ? `${name} copied` : `Copy ${name}`} title={copied === name ? "Copied" : "Copy secret"} onClick={() => void copy(name, value)}>{copied === name ? <CheckIcon /> : <CopyIcon />}</button> : <Badge tone="red">Missing</Badge>}</div>)}</div></article>;
}

function Configuration({ data }: { data: AdminOverview }) { return <><header className="page-head"><div><h1>Configuration</h1><p>Inspect provider readiness and protected runtime settings.</p></div></header><section className="configuration-secrets"><PlatformSecrets /></section><div className="section-heading"><span>Channels &amp; providers</span><span className="section-line" /></div><ProvidersPanel providers={data.config.providers} /></>; }

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null); const [sessionUser, setSessionUser] = useState<SessionUser | null>(null); const [page, setPage] = useState<Page>(readPage); const [theme, setTheme] = useState<Theme>(readTheme); const [overview, setOverview] = useState<AdminOverview | null>(null); const [activity, setActivity] = useState<AdminActivity | null>(null); const [error, setError] = useState(""); const [loading, setLoading] = useState(false); const [refreshSignal, setRefreshSignal] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === "true");
  const load = useCallback(async () => { setLoading(true); setError(""); setRefreshSignal((n) => n + 1); try { const [nextOverview, nextActivity] = await Promise.all([fetchOverview(), fetchActivity()]); setOverview(nextOverview); setActivity(nextActivity); } catch (reason) { if (reason instanceof Error && reason.message.includes("Authentication")) setAuthenticated(false); else { const m = reason instanceof Error ? reason.message : "Unable to connect"; setError(m); toast.error("Cannot load dispatcher state", { description: m }); } } finally { setLoading(false); } }, []);
  useEffect(() => { void fetchSession().then((session) => { setAuthenticated(session.authenticated); setSessionUser(session.user ?? null); }).catch(() => setAuthenticated(false)); }, []);
  useEffect(() => { if (authenticated) void load(); }, [authenticated, load]);
  useEffect(() => {
    const handler = () => {
      const first = window.location.hash.replace(/^#\/?/, "").split("?")[0].split("/")[0];
      if (first in LEGACY_PAGES) { window.location.replace("#campaigns"); return; }
      setPage(readPage());
    };
    handler();
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  useEffect(() => { if (theme === "system") { document.documentElement.removeAttribute("data-theme"); localStorage.removeItem(THEME_KEY); } else { document.documentElement.dataset.theme = theme; localStorage.setItem(THEME_KEY, theme); } }, [theme]);
  useEffect(() => { localStorage.setItem(SIDEBAR_KEY, String(sidebarCollapsed)); }, [sidebarCollapsed]);
  // Mounted on every branch (login/accept/shell) so toasts work everywhere.
  const toaster = <Toaster theme={theme} />;
  // Invite acceptance is reachable without an existing session.
  if (window.location.hash.replace(/^#\/?/, "").startsWith("settings/accept")) return <><AcceptInvite />{toaster}</>;
  if (authenticated === null) return <><div className="loading-state"><span className="loader" />Checking access…</div>{toaster}</>;
  if (!authenticated) return <><Login onSuccess={() => { setAuthenticated(true); void fetchSession().then((s) => setSessionUser(s.user ?? null)); }} />{toaster}</>;
  const cycleTheme = () => setTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light"); const ThemeIcon = theme === "light" ? SunIcon : theme === "dark" ? MoonIcon : MonitorIcon;
  return <TooltipProvider>
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">SM</div>
          <span className="brand-name">dispatcher</span>
          <button type="button" className="sidebar-trigger" aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={() => setSidebarCollapsed((value) => !value)}><SidebarIcon collapsed={sidebarCollapsed} /></button>
        </div>
        <nav>{NAV.map(([id, label, icon]) => <button key={id} type="button" title={sidebarCollapsed ? label : undefined} className={`nav-item ${page === id ? "active" : ""}`} onClick={() => navigate(id)}>{icon}<span>{label}</span></button>)}</nav>
        <div className="sidebar-footer">
          <div className="access-state"><ShieldIcon /><span><strong>Protected access</strong><small>Operator console</small></span></div>
          <div className="footer-environment"><span className={`dot dot-${overview ? tone(overview.status.status) : "muted"}`} /><span>{overview?.runtime.environment ?? "connecting"}</span></div>
          {overview && <div className="footer-version"><span>Version</span><code>v{overview.build.version}</code></div>}
          <button type="button" className="footer-action" title={sidebarCollapsed ? `${theme} theme` : undefined} onClick={cycleTheme}><ThemeIcon /> <span>{theme} theme</span></button>
          <button type="button" className="footer-action" title={sidebarCollapsed ? "Sign out" : undefined} onClick={() => void signOut().finally(() => { setSessionUser(null); setAuthenticated(false); })}><ShieldIcon /> <span>Sign out</span></button>
        </div>
      </aside>
      <main className="main"><div className="main-inner"><div className="topbar"><button type="button" className="refresh-button" onClick={() => void load()} disabled={loading}><RefreshIcon className={loading ? "spin" : ""} />Refresh</button></div>{error && <div className="error-state"><AlertIcon /><strong>Cannot load dispatcher state</strong><p>{error}</p></div>}{overview && activity && page === "overview" && <Overview overview={overview} activity={activity} />}{page === "campaigns" && <Campaigns activity={activity} refreshSignal={refreshSignal} />}{page === "variables" && <Variables refreshSignal={refreshSignal} />}{page === "logs" && <Logs refreshSignal={refreshSignal} />}{page === "settings" && <Settings user={sessionUser} refreshSignal={refreshSignal} />}{overview && page === "runtime" && <Runtime data={overview} />}{overview && page === "configuration" && <Configuration data={overview} />}{activity && page !== "settings" && <footer className="page-footer"><ClockIcon />Activity persisted in the dispatcher state database · process up since {formatTime(activity.scope.started_at)}</footer>}</div></main>
    </div>
    {toaster}
  </TooltipProvider>;
}
