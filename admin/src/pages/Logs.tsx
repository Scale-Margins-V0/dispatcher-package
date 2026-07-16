import { Fragment, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { fetchLogs } from "../api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertIcon, ChevronIcon, ClockIcon } from "../icons";
import type { LogEntry } from "../types";

/** Radix Select reserves "" — use an explicit sentinel for "no level filter". */
const ALL_LEVELS = "all";
const LEVELS = ["debug", "info", "warn", "error", "fatal"] as const;

const levelTone = (level: LogEntry["level"]) =>
  level === "error" || level === "fatal" ? "red" : level === "warn" ? "amber" : "muted";

const formatTime = (value: string) => new Date(value).toLocaleString();

type Filters = { level: string; campaign_id: string; q: string };

export default function Logs({ refreshSignal = 0 }: { refreshSignal?: number }) {
  const [filters, setFilters] = useState<Filters>({ level: "", campaign_id: "", q: "" });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (append = false, nextCursor?: string | null) => {
      setLoading(true);
      setError("");
      try {
        const params: Record<string, string> = { limit: "100" };
        if (filters.level) params.level = filters.level;
        if (filters.campaign_id.trim()) params.campaign_id = filters.campaign_id.trim();
        if (filters.q.trim()) params.q = filters.q.trim();
        if (append && nextCursor) params.cursor = nextCursor;
        const page = await fetchLogs(params);
        setLogs((prev) => (append ? [...prev, ...page.logs] : page.logs));
        setCursor(page.next_cursor);
      } catch (reason) {
        const m = reason instanceof Error ? reason.message : "Unable to load logs";
        setError(m);
        toast.error("Could not load logs", { description: m });
      } finally {
        setLoading(false);
      }
    },
    [filters]
  );

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Logs</h1>
          <p>
            Structured application logs persisted in the dispatcher database — full error
            messages and stack traces, correlated by request and campaign.
          </p>
        </div>
      </header>
      <section className="panel log-filters">
        <Select
          value={filters.level || ALL_LEVELS}
          onValueChange={(value) =>
            setFilters({ ...filters, level: value === ALL_LEVELS ? "" : value })
          }
        >
          <SelectTrigger className="w-[150px]" aria-label="Filter by level">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_LEVELS}>All levels</SelectItem>
            {LEVELS.map((level) => (
              <SelectItem key={level} value={level}>
                {level}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <input
          placeholder="Campaign id"
          value={filters.campaign_id}
          onChange={(event) => setFilters({ ...filters, campaign_id: event.target.value })}
        />
        <input
          placeholder="Search message text"
          value={filters.q}
          onChange={(event) => setFilters({ ...filters, q: event.target.value })}
        />
      </section>
      {error && (
        <div className="error-state">
          <AlertIcon />
          <strong>Logs</strong>
          <p>{error}</p>
        </div>
      )}
      {!error && logs.length === 0 && !loading && (
        <div className="empty-state">
          <ClockIcon />
          <strong>No matching log entries</strong>
          <span>Logs appear here as the dispatcher handles traffic.</span>
        </div>
      )}
      {logs.length > 0 && (
        <section className="table-wrap scroll-x">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Level</th>
                <th>Component</th>
                <th>Campaign</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => {
                const open = openId === log.id;
                return (
                  <Fragment key={log.id}>
                    <tr
                      className={`log-row ${open ? "active" : ""}`}
                      onClick={() => setOpenId(open ? null : log.id)}
                    >
                      <td className="mono nowrap">{formatTime(log.ts)}</td>
                      <td>
                        <span className={`badge badge-${levelTone(log.level)}`}>{log.level}</span>
                      </td>
                      <td className="mono">{log.component ?? "—"}</td>
                      <td className="mono">{log.campaign_id ?? "—"}</td>
                      <td className="message-cell">
                        <ChevronIcon className={`log-chevron ${open ? "open" : ""}`} />
                        {log.message}
                      </td>
                    </tr>
                    {open && (
                      <tr className="log-detail-row">
                        <td colSpan={5}>
                          <div className="log-detail-inner">
                            <dl className="log-meta">
                              <div>
                                <dt>Time</dt>
                                <dd className="mono">{log.ts}</dd>
                              </div>
                              <div>
                                <dt>Level</dt>
                                <dd>{log.level}</dd>
                              </div>
                              <div>
                                <dt>Request</dt>
                                <dd className="mono">{log.request_id ?? "—"}</dd>
                              </div>
                              <div>
                                <dt>Campaign</dt>
                                <dd className="mono">{log.campaign_id ?? "—"}</dd>
                              </div>
                              <div>
                                <dt>Component</dt>
                                <dd className="mono">{log.component ?? "—"}</dd>
                              </div>
                            </dl>
                            <div className="log-message">{log.message}</div>
                            {log.stack && <pre className="stack-trace">{log.stack}</pre>}
                            {log.context && (
                              <pre className="stack-trace">{JSON.stringify(log.context, null, 2)}</pre>
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
        <button type="button" className="ghost load-more" onClick={() => void load(true, cursor)} disabled={loading}>
          {loading ? "Loading…" : "Load older entries"}
        </button>
      )}
    </>
  );
}
