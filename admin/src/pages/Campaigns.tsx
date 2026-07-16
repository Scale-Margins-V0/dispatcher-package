import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { fetchCampaigns } from "../api";
import { InfoTip } from "../components/InfoTip";
import { ServerIcon } from "../icons";
import type { AdminActivity, CampaignSummary, WebhookActivity } from "../types";
import CampaignDetail from "./CampaignDetail";

/** Second hash segment: "#campaigns/<id>[/<tab>]". */
const readCampaignId = (): string | null => {
  const segments = window.location.hash.replace(/^#\/?/, "").split("?")[0].split("/");
  if (segments[0] !== "campaigns" || !segments[1]) return null;
  try {
    return decodeURIComponent(segments[1]);
  } catch {
    return segments[1];
  }
};

export const campaignHash = (id: string, tab?: string): string =>
  `campaigns/${encodeURIComponent(id)}${tab ? `/${tab}` : ""}`;

const formatTime = (value: string) => new Date(value).toLocaleString();

const timeAgo = (value: string): string => {
  const ms = Date.now() - new Date(value).getTime();
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(value).toLocaleDateString();
};

function Stat({ label, value, detail, tone }: { label: ReactNode; value: string | number; detail?: string; tone?: string }) {
  return (
    <article className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={tone ? { color: `var(--${tone})` } : undefined}>
        {value}
      </div>
      {detail && <div className="stat-detail">{detail}</div>}
    </article>
  );
}

function EngagementCell({ summary }: { summary: CampaignSummary }) {
  const events = summary.events;
  if (!events || events.unique_recipients === 0) {
    return <span className="faint-hint">no events yet</span>;
  }
  const bad = events.bounced + events.complained + events.failed;
  return (
    <span className="engagement-cell">
      <span className="eng" title="Delivered">
        <span className="eng-dot g" />
        {events.delivered}
      </span>
      {events.opened > 0 && (
        <span className="eng" title="Opened (email tracking pixel)">
          <span className="eng-dot b" />
          {events.opened}
        </span>
      )}
      {events.read > 0 && (
        <span className="eng" title="Read (WhatsApp receipt)">
          <span className="eng-dot b" />
          {events.read}
        </span>
      )}
      <span className="eng" title="Clicked">
        <span className="eng-dot v" />
        {events.clicked}
      </span>
      {bad > 0 && (
        <span className="eng" title="Bounced / complained / failed">
          <span className="eng-dot r" />
          {bad}
        </span>
      )}
    </span>
  );
}

function ForwardingHealth({ webhooks }: { webhooks: WebhookActivity[] }) {
  if (webhooks.length === 0) return null;
  const tone = (status: string) => (status === "delivered" ? "green" : "red");
  return (
    <>
      <div className="section-heading">
        <span>Analytics forwarding — recent attempts (all campaigns)</span>
        <span className="section-line" />
      </div>
      <section className="table-wrap scroll-x">
        <table>
          <thead>
            <tr>
              <th>Destination</th>
              <th>Status</th>
              <th>Events</th>
              <th>HTTP</th>
              <th>Latency</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {webhooks.slice(0, 8).map((row) => (
              <tr key={row.id}>
                <td className="mono">{row.destination ?? row.provider}</td>
                <td>
                  <span className={`badge badge-${tone(row.status)}`}>{row.status}</span>
                </td>
                <td>{row.event_count}</td>
                <td>{row.http_status ?? "—"}</td>
                <td>{row.duration_ms === undefined ? "—" : `${row.duration_ms} ms`}</td>
                <td>{formatTime(row.occurred_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function CampaignList({
  activity,
  refreshSignal,
}: {
  activity: AdminActivity | null;
  refreshSignal: number;
}) {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (search: string, append = false, nextCursor?: string | null) => {
    setLoading(true);
    try {
      const page = await fetchCampaigns({
        q: search.trim() || undefined,
        cursor: append && nextCursor ? nextCursor : undefined,
      });
      setCampaigns((prev) => (append ? [...prev, ...page.campaigns] : page.campaigns));
      setCursor(page.next_cursor);
    } catch (reason) {
      toast.error("Could not load campaigns", {
        description: reason instanceof Error ? reason.message : undefined,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(q);
    // refreshSignal re-runs the current search; q changes are debounced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal, load]);

  const onSearch = (value: string) => {
    setQ(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void load(value), 300);
  };

  const summary = activity?.summary;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Campaigns</h1>
          <p>
            Every dispatch, delivery stage, provider event, failure and forwarding attempt —
            unified per campaign. Click a campaign for the full recipient journey.
          </p>
        </div>
      </header>

      {summary && (
        <section className="stat-grid campaign-stat-grid">
          <Stat label={<><span>Accepted</span> <InfoTip label="Dispatch requests received by the dispatcher." /></>} value={summary.accepted_dispatches} detail="Dispatch requests" />
          <Stat label={<><span>Completed</span> <InfoTip label="Dispatch runs that finished processing (successfully or not)." /></>} value={summary.completed_dispatches} detail="Dispatch runs" />
          <Stat
            label={<><span>Sent</span> <InfoTip label="Messages successfully handed to the delivery provider." /></>}
            value={summary.sent}
            detail="Messages handed to providers"
            tone={summary.sent > 0 ? "green" : undefined}
          />
          <Stat
            label={<><span>Failed</span> <InfoTip label="Messages that could not be delivered (bounces, provider errors, timeouts)." /></>}
            value={summary.failed}
            detail="Across all campaigns"
            tone={summary.failed > 0 ? "red" : undefined}
          />
          <Stat
            label={<><span>Forwarding</span> <InfoTip label="Percentage of analytics callbacks that were successfully delivered to the registered endpoint in the last 24 hours." /></>}
            value={summary.webhook_success_rate === null ? "—" : `${summary.webhook_success_rate}%`}
            detail="Callback success (24h)"
          />
        </section>
      )}

      <div className="campaign-search">
        <input
          placeholder="Search campaign id…"
          value={q}
          onChange={(event) => onSearch(event.target.value)}
          aria-label="Search campaigns"
        />
      </div>

      {campaigns.length === 0 && !loading ? (
        <div className="empty-state">
          <ServerIcon />
          <strong>No campaigns yet</strong>
          <span>Campaigns appear here as soon as the dispatcher receives traffic.</span>
        </div>
      ) : (
        <section className="table-wrap scroll-x">
          <table>
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Channel</th>
                <th>Runs</th>
                <th>Recipients</th>
                <th>Sent / Failed</th>
                <th>Engagement</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((campaign) => (
                <tr
                  key={campaign.program_id}
                  className="log-row"
                  onClick={() => {
                    window.location.hash = campaignHash(campaign.program_id);
                  }}
                >
                  <td>
                    <button type="button" className="campaign-link">
                      {campaign.program_id}
                    </button>
                    {campaign.has_callback && (
                      <span className="badge badge-muted" style={{ marginLeft: 8 }}>
                        callback
                      </span>
                    )}
                  </td>
                  <td>
                    {campaign.channels.join(", ") || "—"}
                    <span className="faint-hint"> · {campaign.providers.join(", ")}</span>
                  </td>
                  <td>
                    {campaign.runs}
                    {campaign.failed_runs > 0 && (
                      <span className="badge badge-red" style={{ marginLeft: 7 }}>
                        {campaign.failed_runs} failed
                      </span>
                    )}
                  </td>
                  {/*
                    A blast's run carries its intended audience, so use it (and
                    it stays right while the dispatch is still in flight). A
                    drip fans out one run per lead per step, so summing those
                    counts sends, not people — use the distinct headcount.
                  */}
                  <td
                    title={
                      campaign.program_kind === "drip"
                        ? `${campaign.sends.toLocaleString()} sends across ${campaign.steps} steps`
                        : undefined
                    }
                  >
                    {(campaign.program_kind === "drip"
                      ? (campaign.events?.unique_recipients ?? 0)
                      : campaign.recipients
                    ).toLocaleString()}
                  </td>
                  <td className="mono nowrap">
                    <span style={campaign.sent > 0 ? { color: "var(--green)" } : undefined}>
                      {campaign.sent}
                    </span>
                    {" / "}
                    <span style={campaign.failed > 0 ? { color: "var(--red)" } : undefined}>
                      {campaign.failed}
                    </span>
                  </td>
                  <td>
                    <EngagementCell summary={campaign} />
                  </td>
                  <td title={formatTime(campaign.last_activity)}>{timeAgo(campaign.last_activity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {cursor && (
        <button
          type="button"
          className="ghost load-more"
          onClick={() => void load(q, true, cursor)}
          disabled={loading}
        >
          {loading ? "Loading…" : "Load older campaigns"}
        </button>
      )}

      {activity && <ForwardingHealth webhooks={activity.webhooks} />}

      {campaigns.length === 0 && loading && (
        <div className="loading-state">
          <span className="loader" />
          Loading campaigns…
        </div>
      )}
    </>
  );
}

export default function Campaigns({
  activity,
  refreshSignal = 0,
}: {
  activity: AdminActivity | null;
  refreshSignal?: number;
}) {
  const [campaignId, setCampaignId] = useState<string | null>(readCampaignId);

  useEffect(() => {
    const handler = () => setCampaignId(readCampaignId());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  if (campaignId) {
    return <CampaignDetail id={campaignId} refreshSignal={refreshSignal} />;
  }
  return <CampaignList activity={activity} refreshSignal={refreshSignal} />;
}
