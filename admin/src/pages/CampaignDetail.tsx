import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  fetchCampaign,
  fetchCampaignEvents,
  fetchCampaignOutbox,
  fetchCampaignRecipient,
  fetchCampaignRecipients,
  fetchCampaignRuns,
  fetchDispatchDetail,
} from "../api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { InfoTip } from "../components/InfoTip";
import {
  ActivityIcon,
  AlertIcon,
  BellIcon,
  CheckIcon,
  ChevronIcon,
  ClockIcon,
  MailIcon,
  ServerIcon,
  ShieldIcon,
  UsersIcon,
} from "../icons";
import type {
  CampaignEvent,
  CampaignInfo,
  CampaignOutboxEntry,
  DispatchActivity,
  RecipientFailure,
  RecipientRollup,
  RecipientStatus,
  RecipientTimeline,
} from "../types";
import Logs from "./Logs";

const TABS = ["recipients", "events", "runs", "forwarding", "logs"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  recipients: "Recipients",
  events: "Events",
  runs: "Runs",
  forwarding: "Forwarding",
  logs: "Logs",
};

/** One tone vocabulary for every event/status surface in the console. */
const EVENT_TONE: Record<string, string> = {
  delivered: "green",
  opened: "blue",
  read: "blue",
  clicked: "violet",
  bounced: "red",
  complained: "red",
  failed: "red",
  expired: "red",
  unsubscribed: "orange",
  deferred: "amber",
  dispatched: "muted",
  sent: "muted",
  pending: "muted",
  preference_update: "muted",
};
const toneOf = (value: string): string => EVENT_TONE[value] ?? "muted";

/** Mirrors RECIPIENT_STATUS_ORDER in the repo — worst signal first. */
const STATUS_CHIP_ORDER: RecipientStatus[] = [
  "complained",
  "bounced",
  "failed",
  "unsubscribed",
  "clicked",
  "opened",
  "read",
  "delivered",
  "dispatched",
  "pending",
];

const EVENT_TYPES = [
  "dispatched",
  "delivered",
  "opened",
  "read",
  "clicked",
  "bounced",
  "unsubscribed",
  "complained",
  "failed",
  "deferred",
  "expired",
  "preference_update",
];

const formatTime = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString() : "—";

const timeAgo = (value: string): string => {
  const ms = Date.now() - new Date(value).getTime();
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

const pct = (part: number, whole: number): string | null =>
  whole > 0 ? `${Math.round((part / whole) * 1000) / 10}% ` : null;

const readTab = (): Tab => {
  const seg = window.location.hash.replace(/^#\/?/, "").split("?")[0].split("/")[2] as Tab;
  return TABS.includes(seg) ? seg : "recipients";
};

function Badge({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function RawJson({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="raw-json">
      <summary>
        <ChevronIcon /> {label}
      </summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

function StageDots({ recipient }: { recipient: RecipientRollup }) {
  const bad =
    recipient.flags.bounced || recipient.flags.complained || recipient.flags.failed ||
    recipient.flags.unsubscribed;
  return (
    <span
      className="stage-dots"
      title="dispatched · delivered · opened (email) or read (WhatsApp) · clicked · issues"
    >
      <span className={`stage-dot ${recipient.stages.dispatched ? "on sd-n" : ""}`} />
      <span className={`stage-dot ${recipient.stages.delivered ? "on sd-g" : ""}`} />
      {/* One positional "viewed" dot: whichever signal this recipient's channel reports. */}
      <span
        className={`stage-dot ${recipient.stages.opened || recipient.stages.read ? "on sd-b" : ""}`}
      />
      <span className={`stage-dot ${recipient.stages.clicked ? "on sd-v" : ""}`} />
      <span className={`stage-dot ${bad ? "on sd-r" : ""}`} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Per-recipient expanded timeline
// ---------------------------------------------------------------------------

function TimelineIcon({ event }: { event: string }) {
  const tone = toneOf(event);
  const icon =
    event === "delivered" ? <CheckIcon /> :
    event === "opened" || event === "read" ? <MailIcon /> :
    event === "clicked" ? <ActivityIcon /> :
    tone === "red" ? <AlertIcon /> :
    event === "unsubscribed" ? <BellIcon /> :
    <ServerIcon />;
  return <span className={`timeline-icon tl-${tone === "muted" ? "plain" : tone}`}>{icon}</span>;
}

function RecipientTimelinePanel({ campaignId, userId }: { campaignId: string; userId: string }) {
  const [timeline, setTimeline] = useState<RecipientTimeline | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchCampaignRecipient(campaignId, userId)
      .then((data) => {
        if (!cancelled) setTimeline(data);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId, userId]);

  if (error) {
    return (
      <div className="failure-callout">
        <strong>Timeline unavailable</strong>
        {error}
      </div>
    );
  }
  if (!timeline) {
    return (
      <div className="loading-state">
        <span className="loader" />
        Loading journey…
      </div>
    );
  }

  return (
    <div className="log-detail-inner">
      <dl className="detail-kv">
        <div>
          <dt>User</dt>
          <dd className="mono">{timeline.user_id}</dd>
        </div>
        <div>
          <dt>Derived status</dt>
          <dd>
            <Badge tone={toneOf(timeline.status)}>{timeline.status}</Badge>
          </dd>
        </div>
        <div>
          <dt>Events recorded</dt>
          <dd>{timeline.events.length}</dd>
        </div>
      </dl>

      {timeline.events.length > 0 && (
        <div className="timeline">
          {timeline.events.map((event) => (
            <div className="timeline-item" key={event.id}>
              <TimelineIcon event={event.event} />
              <div className="timeline-body">
                <div className="timeline-title">
                  <Badge tone={toneOf(event.event)}>{event.event}</Badge>
                  <span className="timeline-meta">
                    {event.channel} · {event.provider}
                    {event.provider_message_id ? ` · ${event.provider_message_id}` : ""}
                  </span>
                  <span className="timeline-meta" title={`received ${formatTime(event.received_at)}`}>
                    {formatTime(event.occurred_at)}
                  </span>
                </div>
                {event.metadata && Object.keys(event.metadata).length > 0 && (
                  <RawJson label="Event metadata" value={event.metadata} />
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {timeline.recipient_failures.map((failure) => (
        <FailureCallout key={failure.id} failure={failure} />
      ))}
    </div>
  );
}

function FailureCallout({ failure }: { failure: RecipientFailure }) {
  return (
    <div className="failure-callout">
      <strong>
        Send failure · {failure.error_category} · {failure.provider}
      </strong>
      <span>{failure.error_message}</span>
      <span className="timeline-meta">{formatTime(failure.occurred_at)}</span>
      {failure.error_stack && <RawJson label="Stack trace" value={failure.error_stack} />}
      {failure.context && Object.keys(failure.context).length > 0 && (
        <RawJson label="Context" value={failure.context} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function RecipientsTab({ campaignId, refreshSignal }: { campaignId: string; refreshSignal: number }) {
  const [recipients, setRecipients] = useState<RecipientRollup[]>([]);
  const [counts, setCounts] = useState<Partial<Record<RecipientStatus, number>>>({});
  const [status, setStatus] = useState<RecipientStatus | "">("");
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [openUser, setOpenUser] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (opts: { status?: RecipientStatus | ""; q?: string; append?: boolean; cursor?: string | null } = {}) => {
      const effStatus = opts.status ?? status;
      const effQ = opts.q ?? q;
      setLoading(true);
      try {
        const page = await fetchCampaignRecipients(campaignId, {
          status: effStatus || undefined,
          q: effQ.trim() || undefined,
          cursor: opts.append && opts.cursor ? opts.cursor : undefined,
        });
        setRecipients((prev) => (opts.append ? [...prev, ...page.recipients] : page.recipients));
        setCounts(page.status_counts);
        setCursor(page.next_cursor);
      } catch (reason) {
        toast.error("Could not load recipients", {
          description: reason instanceof Error ? reason.message : undefined,
        });
      } finally {
        setLoading(false);
      }
    },
    [campaignId, status, q]
  );

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, refreshSignal]);

  const totalKnown = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);

  const pickStatus = (next: RecipientStatus | "") => {
    setStatus(next);
    setOpenUser(null);
    void load({ status: next });
  };

  return (
    <>
      <div className="chips-row">
        <button
          type="button"
          className={`status-chip ${status === "" ? "active" : ""}`}
          onClick={() => pickStatus("")}
        >
          All <span className="chip-count">{totalKnown}</span>
        </button>
        {STATUS_CHIP_ORDER.filter((name) => (counts[name] ?? 0) > 0).map((name) => (
          <button
            key={name}
            type="button"
            className={`status-chip ${status === name ? "active" : ""}`}
            onClick={() => pickStatus(name)}
          >
            <span className={`dot dot-${toneOf(name)}`} style={{ width: 7, height: 7 }} />
            {name} <span className="chip-count">{counts[name]}</span>
          </button>
        ))}
      </div>

      <div className="campaign-search">
        <input
          placeholder="Search user id…"
          value={q}
          onChange={(event) => {
            const value = event.target.value;
            setQ(value);
            if (debounce.current) clearTimeout(debounce.current);
            debounce.current = setTimeout(() => void load({ q: value }), 300);
          }}
          aria-label="Search recipients"
        />
      </div>

      {recipients.length === 0 && !loading ? (
        <div className="empty-state">
          <UsersIcon />
          <strong>No recipient events{status ? ` with status "${status}"` : " yet"}</strong>
          <span>Stages appear as providers confirm delivery, opens and clicks.</span>
        </div>
      ) : (
        <section className="table-wrap scroll-x">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Stages</th>
                <th>Status</th>
                <th>Events</th>
                <th>First seen</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((recipient) => {
                const open = openUser === recipient.user_id;
                return (
                  <Fragment key={recipient.user_id}>
                    <tr
                      className={`log-row ${open ? "active" : ""}`}
                      onClick={() => setOpenUser(open ? null : recipient.user_id)}
                    >
                      <td className="mono">
                        <ChevronIcon className={`log-chevron ${open ? "open" : ""}`} />
                        {recipient.user_id}
                      </td>
                      <td>
                        <StageDots recipient={recipient} />
                      </td>
                      <td>
                        <Badge tone={toneOf(recipient.status)}>{recipient.status}</Badge>
                      </td>
                      <td>{recipient.event_count}</td>
                      <td title={formatTime(recipient.first_event_at)}>
                        {timeAgo(recipient.first_event_at)}
                      </td>
                      <td title={formatTime(recipient.last_event_at)}>
                        {timeAgo(recipient.last_event_at)}
                      </td>
                    </tr>
                    {open && (
                      <tr className="log-detail-row">
                        <td colSpan={6}>
                          <RecipientTimelinePanel campaignId={campaignId} userId={recipient.user_id} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {cursor && (
        <button
          type="button"
          className="ghost load-more"
          onClick={() => void load({ append: true, cursor })}
          disabled={loading}
        >
          {loading ? "Loading…" : "Load more recipients"}
        </button>
      )}
    </>
  );
}

const ALL_EVENTS = "all";

function EventsTab({ campaignId, refreshSignal }: { campaignId: string; refreshSignal: number }) {
  const [events, setEvents] = useState<CampaignEvent[]>([]);
  const [type, setType] = useState("");
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (opts: { type?: string; q?: string; append?: boolean; cursor?: string | null } = {}) => {
      const effType = opts.type ?? type;
      const effQ = opts.q ?? q;
      setLoading(true);
      try {
        const page = await fetchCampaignEvents(campaignId, {
          event: effType || undefined,
          q: effQ.trim() || undefined,
          cursor: opts.append && opts.cursor ? opts.cursor : undefined,
        });
        setEvents((prev) => (opts.append ? [...prev, ...page.events] : page.events));
        setCursor(page.next_cursor);
      } catch (reason) {
        toast.error("Could not load events", {
          description: reason instanceof Error ? reason.message : undefined,
        });
      } finally {
        setLoading(false);
      }
    },
    [campaignId, type, q]
  );

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, refreshSignal]);

  return (
    <>
      <section className="panel log-filters">
        <Select
          value={type || ALL_EVENTS}
          onValueChange={(value) => {
            const next = value === ALL_EVENTS ? "" : value;
            setType(next);
            void load({ type: next });
          }}
        >
          <SelectTrigger className="w-[190px]" aria-label="Filter by event type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_EVENTS}>All events</SelectItem>
            {EVENT_TYPES.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <input
          placeholder="Search user or message id"
          value={q}
          onChange={(event) => {
            const value = event.target.value;
            setQ(value);
            if (debounce.current) clearTimeout(debounce.current);
            debounce.current = setTimeout(() => void load({ q: value }), 300);
          }}
        />
      </section>

      {events.length === 0 && !loading ? (
        <div className="empty-state">
          <ActivityIcon />
          <strong>No provider events{type ? ` of type "${type}"` : " yet"}</strong>
          <span>Delivery, open, click and bounce events land here as providers report them.</span>
        </div>
      ) : (
        <section className="table-wrap scroll-x">
          <table>
            <thead>
              <tr>
                <th>Occurred</th>
                <th>Event</th>
                <th>User</th>
                <th>Provider</th>
                <th>Message id</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => {
                const open = openId === event.id;
                const failureReason =
                  (event.metadata?.bounce_reason as string | undefined) ??
                  (event.metadata?.canonical_reason as string | undefined);
                return (
                  <Fragment key={event.id}>
                    <tr
                      className={`log-row ${open ? "active" : ""}`}
                      onClick={() => setOpenId(open ? null : event.id)}
                    >
                      <td className="mono nowrap" title={formatTime(event.occurred_at)}>
                        {timeAgo(event.occurred_at)}
                      </td>
                      <td>
                        <ChevronIcon className={`log-chevron ${open ? "open" : ""}`} />
                        <Badge tone={toneOf(event.event)}>{event.event}</Badge>
                      </td>
                      <td className="mono">{event.user_id}</td>
                      <td>{event.provider}</td>
                      <td className="mono preview-cell" title={event.provider_message_id ?? undefined}>
                        {event.provider_message_id ?? "—"}
                      </td>
                    </tr>
                    {open && (
                      <tr className="log-detail-row">
                        <td colSpan={5}>
                          <div className="log-detail-inner">
                            {failureReason && (
                              <div className="failure-callout">
                                <strong>Provider response</strong>
                                <span>{failureReason}</span>
                              </div>
                            )}
                            <dl className="detail-kv">
                              <div>
                                <dt>Occurred at</dt>
                                <dd className="mono">{event.occurred_at}</dd>
                              </div>
                              <div>
                                <dt>Received at</dt>
                                <dd className="mono">{event.received_at}</dd>
                              </div>
                              <div>
                                <dt>Channel</dt>
                                <dd>{event.channel}</dd>
                              </div>
                              <div>
                                <dt>Provider</dt>
                                <dd>{event.provider}</dd>
                              </div>
                              <div>
                                <dt>Provider message id</dt>
                                <dd className="mono">{event.provider_message_id ?? "—"}</dd>
                              </div>
                              <div>
                                <dt>Organization</dt>
                                <dd className="mono">{event.organization_id}</dd>
                              </div>
                            </dl>
                            {event.metadata && Object.keys(event.metadata).length > 0 && (
                              <RawJson label="Event metadata" value={event.metadata} />
                            )}
                            <RawJson label="Stored event row" value={event} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {cursor && (
        <button
          type="button"
          className="ghost load-more"
          onClick={() => void load({ append: true, cursor })}
          disabled={loading}
        >
          {loading ? "Loading…" : "Load older events"}
        </button>
      )}
    </>
  );
}

function RunsTab({ campaignId, refreshSignal }: { campaignId: string; refreshSignal: number }) {
  const [runs, setRuns] = useState<DispatchActivity[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [failures, setFailures] = useState<Record<string, RecipientFailure[]>>({});
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (append = false, nextCursor?: string | null) => {
      setLoading(true);
      try {
        const page = await fetchCampaignRuns(campaignId, {
          cursor: append && nextCursor ? nextCursor : undefined,
        });
        setRuns((prev) => (append ? [...prev, ...page.dispatches] : page.dispatches));
        setCursor(page.next_cursor);
      } catch (reason) {
        toast.error("Could not load dispatch runs", {
          description: reason instanceof Error ? reason.message : undefined,
        });
      } finally {
        setLoading(false);
      }
    },
    [campaignId]
  );

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  const toggleRun = async (run: DispatchActivity) => {
    const open = openId === run.id;
    setOpenId(open ? null : run.id);
    if (!open && failures[run.id] === undefined) {
      try {
        const detail = await fetchDispatchDetail(run.id);
        setFailures((prev) => ({ ...prev, [run.id]: detail.recipient_failures }));
      } catch {
        setFailures((prev) => ({ ...prev, [run.id]: [] }));
      }
    }
  };

  const runTone = (status: string) =>
    status === "completed" ? "green" : status === "accepted" ? "amber" : "red";

  return (
    <>
      {runs.length === 0 && !loading ? (
        <div className="empty-state">
          <ServerIcon />
          <strong>No dispatch runs</strong>
          <span>Each POST to the dispatch endpoint becomes a run here.</span>
        </div>
      ) : (
        <section className="table-wrap scroll-x">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Status</th>
                <th>Channel</th>
                <th>Recipients</th>
                <th>Result</th>
                <th>Duration</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const open = openId === run.id;
                const runFailures = failures[run.id];
                return (
                  <Fragment key={run.id}>
                    <tr className={`log-row ${open ? "active" : ""}`} onClick={() => void toggleRun(run)}>
                      <td className="mono">
                        <ChevronIcon className={`log-chevron ${open ? "open" : ""}`} />
                        {run.id.slice(0, 8)}…
                      </td>
                      <td>
                        <Badge tone={runTone(run.status)}>{run.status}</Badge>
                      </td>
                      <td>
                        {run.channel} · {run.provider}
                      </td>
                      <td>{run.recipient_count}</td>
                      <td className="mono nowrap">
                        {run.sent_count === undefined || run.sent_count === null
                          ? "—"
                          : `${run.sent_count} sent / ${run.failed_count ?? 0} failed`}
                      </td>
                      <td>{run.duration_ms == null ? "—" : `${run.duration_ms} ms`}</td>
                      <td>{formatTime(run.occurred_at)}</td>
                    </tr>
                    {open && (
                      <tr className="log-detail-row">
                        <td colSpan={7}>
                          <div className="log-detail-inner">
                            {run.error_message && (
                              <div className="failure-callout">
                                <strong>Run error · {run.error_category ?? "unknown"}</strong>
                                <span>{run.error_message}</span>
                                {run.error_stack && (
                                  <RawJson label="Stack trace" value={run.error_stack} />
                                )}
                              </div>
                            )}
                            {runFailures === undefined ? (
                              <div className="loading-state">
                                <span className="loader" />
                                Loading recipient failures…
                              </div>
                            ) : runFailures.length === 0 ? (
                              <div className="timeline-meta">
                                No per-recipient failures recorded for this run.
                              </div>
                            ) : (
                              runFailures.map((failure) => (
                                <FailureCallout key={failure.id} failure={failure} />
                              ))
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {cursor && (
        <button
          type="button"
          className="ghost load-more"
          onClick={() => void load(true, cursor)}
          disabled={loading}
        >
          {loading ? "Loading…" : "Load older runs"}
        </button>
      )}
    </>
  );
}

const ALL_OUTBOX = "all";

function ForwardingTab({
  campaign,
  refreshSignal,
}: {
  campaign: CampaignInfo;
  refreshSignal: number;
}) {
  const [entries, setEntries] = useState<CampaignOutboxEntry[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (opts: { status?: string; append?: boolean; cursor?: string | null } = {}) => {
      const effStatus = opts.status ?? status;
      setLoading(true);
      try {
        const page = await fetchCampaignOutbox(campaign.program_id, {
          status: effStatus || undefined,
          cursor: opts.append && opts.cursor ? opts.cursor : undefined,
        });
        setEntries((prev) => (opts.append ? [...prev, ...page.entries] : page.entries));
        setCounts(page.status_counts);
        setCursor(page.next_cursor);
      } catch (reason) {
        toast.error("Could not load forwarding queue", {
          description: reason instanceof Error ? reason.message : undefined,
        });
      } finally {
        setLoading(false);
      }
    },
    [campaign.program_id, status]
  );

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign.program_id, refreshSignal]);

  const outboxTone = (name: string) =>
    name === "delivered" ? "green" : name === "failed" ? "red" : "amber";

  return (
    <>
      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-title">
          <ShieldIcon /> Analytics callback
        </div>
        {campaign.callback ? (
          <dl className="detail-kv" style={{ marginTop: 10 }}>
            <div>
              <dt>Destination</dt>
              <dd className="mono">{campaign.callback.destination}</dd>
            </div>
            <div>
              <dt>Last used</dt>
              <dd>{formatTime(campaign.callback.last_used_at)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <Badge tone="green">registered</Badge>
              </dd>
            </div>
          </dl>
        ) : (
          <p className="timeline-meta" style={{ marginTop: 8 }}>
            No analytics callback registered for this campaign — events are recorded in this
            console but not forwarded anywhere.
          </p>
        )}
      </section>

      <div className="chips-row">
        <button
          type="button"
          className={`status-chip ${status === "" ? "active" : ""}`}
          onClick={() => {
            setStatus("");
            void load({ status: "" });
          }}
        >
          All <span className="chip-count">{Object.values(counts).reduce((sum, n) => sum + n, 0)}</span>
        </button>
        {["pending", "delivering", "delivered", "failed"]
          .filter((name) => (counts[name] ?? 0) > 0)
          .map((name) => (
            <button
              key={name}
              type="button"
              className={`status-chip ${status === name ? "active" : ""}`}
              onClick={() => {
                setStatus(name);
                void load({ status: name });
              }}
            >
              <span className={`dot dot-${outboxTone(name)}`} style={{ width: 7, height: 7 }} />
              {name} <span className="chip-count">{counts[name]}</span>
            </button>
          ))}
      </div>

      {entries.length === 0 && !loading ? (
        <div className="empty-state">
          <ClockIcon />
          <strong>Nothing in the forwarding queue</strong>
          <span>
            Events queue here on their way to the client's analytics callback. Delivered entries
            are pruned after a week.
          </span>
        </div>
      ) : (
        <section className="table-wrap scroll-x">
          <table>
            <thead>
              <tr>
                <th>Queued</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Next attempt</th>
                <th>Destination</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const open = openId === entry.id;
                return (
                  <Fragment key={entry.id}>
                    <tr
                      className={`log-row ${open ? "active" : ""}`}
                      onClick={() => setOpenId(open ? null : entry.id)}
                    >
                      <td className="mono nowrap" title={formatTime(entry.created_at)}>
                        <ChevronIcon className={`log-chevron ${open ? "open" : ""}`} />
                        {timeAgo(entry.created_at)}
                      </td>
                      <td>
                        <Badge tone={outboxTone(entry.status)}>{entry.status}</Badge>
                      </td>
                      <td>{entry.attempts}</td>
                      <td>{entry.status === "delivered" ? "—" : formatTime(entry.next_attempt_at)}</td>
                      <td className="mono preview-cell">{entry.destination}</td>
                      <td className="message-cell">{entry.last_error ?? "—"}</td>
                    </tr>
                    {open && (
                      <tr className="log-detail-row">
                        <td colSpan={6}>
                          <div className="log-detail-inner">
                            <dl className="detail-kv">
                              <div>
                                <dt>Queued at</dt>
                                <dd className="mono">{entry.created_at}</dd>
                              </div>
                              <div>
                                <dt>Delivered at</dt>
                                <dd className="mono">{entry.delivered_at ?? "—"}</dd>
                              </div>
                              <div>
                                <dt>Attempts</dt>
                                <dd>{entry.attempts}</dd>
                              </div>
                            </dl>
                            {entry.last_error && (
                              <div className="failure-callout">
                                <strong>Last delivery error</strong>
                                <span>{entry.last_error}</span>
                              </div>
                            )}
                            <RawJson label="Forwarded event envelope" value={entry.event} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {cursor && (
        <button
          type="button"
          className="ghost load-more"
          onClick={() => void load({ append: true, cursor })}
          disabled={loading}
        >
          {loading ? "Loading…" : "Load older entries"}
        </button>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Detail page shell
// ---------------------------------------------------------------------------

type FunnelTile = {
  key: keyof CampaignInfo["funnel"];
  label: string;
  tone: string;
  rateOf?: keyof CampaignInfo["funnel"];
  tip?: string;
};

/**
 * Each channel reports "was it seen?" differently, so the tile speaks that
 * channel's vocabulary rather than averaging them into a single "Opened":
 *   email / push -> `opened`, a tracking pixel (inflated by Apple Mail privacy
 *                   protection, suppressed when images are blocked)
 *   whatsapp     -> `read`, a receipt the recipient can switch off entirely
 *   sms          -> nothing at all; carriers report no view signal
 */
const VIEW_TILE_BY_CHANNEL: Record<string, FunnelTile> = {
  email: { key: "opened", label: "Opened", tone: "blue", rateOf: "delivered", tip: "Recipient loaded the email's tracking pixel. Inflated by Apple Mail privacy protection and missed when images are blocked." },
  push: { key: "opened", label: "Opened", tone: "blue", rateOf: "delivered", tip: "Recipient opened the push notification." },
  whatsapp: { key: "read", label: "Read", tone: "blue", rateOf: "delivered", tip: "WhatsApp read receipt (blue ticks). Accurate when on, but recipients can disable receipts." },
  // sms: intentionally absent — there is no view signal to show.
};

const BASE_TILES: FunnelTile[] = [
  { key: "dispatched", label: "Dispatched", tone: "plain", tip: "Messages successfully handed to the delivery provider." },
  { key: "delivered", label: "Delivered", tone: "green", rateOf: "dispatched", tip: "Confirmed received by the recipient." },
];
const TAIL_TILES: FunnelTile[] = [
  { key: "clicked", label: "Clicked", tone: "violet", rateOf: "delivered", tip: "Recipient clicked a link in the message." },
  { key: "bounced", label: "Bounced", tone: "red", rateOf: "dispatched", tip: "Permanent delivery failure (invalid address, rejected by provider)." },
  { key: "complained", label: "Complained", tone: "red", rateOf: "dispatched", tip: "Recipient marked the message as spam." },
  { key: "unsubscribed", label: "Unsubscribed", tone: "orange", rateOf: "dispatched", tip: "Recipient opted out of future messages." },
  { key: "failed", label: "Failed", tone: "red", rateOf: "dispatched", tip: "Transient delivery failure (provider error, timeout)." },
];

/**
 * A drip picks a channel per step, so one program can span several — show a
 * view tile for each channel that actually reports one.
 */
function funnelTiles(channels: string[], funnel: CampaignInfo["funnel"]): FunnelTile[] {
  const views = new Map<string, FunnelTile>();
  for (const channel of channels) {
    const tile = VIEW_TILE_BY_CHANNEL[channel];
    if (tile) views.set(tile.key, tile);
  }
  // No runs left to name the channels (events-only, or runs aged out): fall
  // back to whichever signal actually has data.
  if (views.size === 0) {
    if (funnel.opened > 0) views.set("opened", VIEW_TILE_BY_CHANNEL.email);
    if (funnel.read > 0) views.set("read", VIEW_TILE_BY_CHANNEL.whatsapp);
  }
  return [...BASE_TILES, ...views.values(), ...TAIL_TILES];
}

export default function CampaignDetail({
  id,
  refreshSignal = 0,
}: {
  id: string;
  refreshSignal?: number;
}) {
  const [campaign, setCampaign] = useState<CampaignInfo | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>(readTab);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const handler = () => setTab(readTab());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const load = useCallback(async () => {
    setError("");
    try {
      const { campaign: data } = await fetchCampaign(id);
      setCampaign(data);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Unable to load the campaign";
      setError(message);
    }
  }, [id]);

  useEffect(() => {
    setCampaign(null);
    void load();
  }, [load, refreshSignal]);

  // Status-aware polling: refresh the header + active tab while dispatching.
  useEffect(() => {
    if (!campaign?.active) return;
    const timer = setInterval(() => {
      void load();
      setTick((n) => n + 1);
    }, 15_000);
    return () => clearInterval(timer);
  }, [campaign?.active, load]);

  const tabRefresh = refreshSignal * 1000 + tick;

  const selectTab = (next: Tab) => {
    window.location.hash = `campaigns/${encodeURIComponent(id)}/${next}`;
  };

  if (error) {
    return (
      <>
        <button type="button" className="crumb" onClick={() => (window.location.hash = "campaigns")}>
          <ChevronIcon /> All campaigns
        </button>
        <div className="error-state">
          <AlertIcon />
          <strong>Campaign</strong>
          <p>{error}</p>
        </div>
      </>
    );
  }

  if (!campaign) {
    return (
      <div className="loading-state">
        <span className="loader" />
        Loading campaign…
      </div>
    );
  }

  const funnel = campaign.funnel;

  return (
    <>
      <button type="button" className="crumb" onClick={() => (window.location.hash = "campaigns")}>
        <ChevronIcon /> All campaigns
      </button>

      <header className="page-head">
        <div>
          <div className="campaign-title-row">
            <h1 className="mono">{campaign.program_id}</h1>
            {campaign.active && (
              <span className="badge badge-amber active-pulse">
                <span className="dot dot-amber" /> dispatching
              </span>
            )}
            {campaign.channels.map((channel) => (
              <Badge key={channel} tone="muted">
                {channel}
              </Badge>
            ))}
            {campaign.providers.map((provider) => (
              <Badge key={provider} tone="muted">
                {provider}
              </Badge>
            ))}
            <Badge tone={campaign.callback ? "green" : "muted"}>
              {campaign.callback ? "callback registered" : "no callback"} <InfoTip label={campaign.callback ? "Analytics events are forwarded to the registered endpoint after processing." : "No analytics callback configured — events are visible in this console only."} />
            </Badge>
          </div>
          <p>
            {campaign.runs} run{campaign.runs === 1 ? "" : "s"} · {campaign.recipients} recipients ·
            first seen {formatTime(campaign.first_activity)} · last activity{" "}
            {formatTime(campaign.last_activity)}
            {campaign.organization_id ? ` · org ${campaign.organization_id}` : ""}
          </p>
        </div>
      </header>

      <div className="funnel-grid">
        {funnelTiles(campaign.channels, funnel).map((tile) => {
          const value = funnel[tile.key];
          const base = tile.rateOf ? funnel[tile.rateOf] : 0;
          const rate = tile.rateOf && value > 0 ? pct(value, base) : null;
          return (
            <div key={tile.key} className={`funnel-tile ${value > 0 ? `t-${tile.tone}` : ""}`}>
              <div className="funnel-label">{tile.label}{tile.tip && <InfoTip label={tile.tip} />}</div>
              <div className="funnel-value">{value.toLocaleString()}</div>
              <div className="funnel-rate">{rate ? `${rate}of ${tile.rateOf}` : ""}</div>
            </div>
          );
        })}
      </div>

      <div className="subtabs">
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            className={`subtab ${tab === name ? "active" : ""}`}
            onClick={() => selectTab(name)}
          >
            {TAB_LABELS[name]}
          </button>
        ))}
      </div>

      {tab === "recipients" && <RecipientsTab campaignId={id} refreshSignal={tabRefresh} />}
      {tab === "events" && <EventsTab campaignId={id} refreshSignal={tabRefresh} />}
      {tab === "runs" && <RunsTab campaignId={id} refreshSignal={tabRefresh} />}
      {tab === "forwarding" && <ForwardingTab campaign={campaign} refreshSignal={tabRefresh} />}
      {tab === "logs" && <Logs presetCampaignId={id} refreshSignal={tabRefresh} />}
    </>
  );
}
