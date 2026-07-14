import { useCallback, useEffect, useState } from "react";
import { fetchLogs } from "../api";
import { AlertIcon, ClockIcon, RefreshIcon } from "../icons";
import type { LogEntry } from "../types";

const LEVELS = ["", "debug", "info", "warn", "error", "fatal"] as const;

const levelTone = (level: LogEntry["level"]) =>
  level === "error" || level === "fatal" ? "red" : level === "warn" ? "amber" : "muted";

const formatTime = (value: string) => new Date(value).toLocaleString();

type Filters = { level: string; campaign_id: string; q: string };

export default function Logs() {
  const [filters, setFilters] = useState<Filters>({ level: "", campaign_id: "", q: "" });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<LogEntry | null>(null);
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
        setError(reason instanceof Error ? reason.message : "Unable to load logs");
      } finally {
        setLoading(false);
      }
    },
    [filters]
  );

  useEffect(() => {
    void load();
  }, [load]);

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
        <button type="button" className="refresh-button" onClick={() => void load()} disabled={loading}>
          <RefreshIcon className={loading ? "spin" : ""} /> Refresh
        </button>
      </header>
      <section className="panel log-filters">
        <select
          value={filters.level}
          onChange={(event) => setFilters({ ...filters, level: event.target.value })}
        >
          {LEVELS.map((level) => (
            <option key={level} value={level}>
              {level === "" ? "All levels" : level}
            </option>
          ))}
        </select>
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
        <section className="table-wrap">
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
              {logs.map((log) => (
                <tr
                  key={log.id}
                  className={`log-row ${selected?.id === log.id ? "active" : ""}`}
                  onClick={() => setSelected(selected?.id === log.id ? null : log)}
                >
                  <td className="mono nowrap">{formatTime(log.ts)}</td>
                  <td>
                    <span className={`badge badge-${levelTone(log.level)}`}>{log.level}</span>
                  </td>
                  <td className="mono">{log.component ?? "—"}</td>
                  <td className="mono">{log.campaign_id ?? "—"}</td>
                  <td className="message-cell">{log.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {cursor && (
        <button type="button" className="ghost load-more" onClick={() => void load(true, cursor)} disabled={loading}>
          {loading ? "Loading…" : "Load older entries"}
        </button>
      )}
      {selected && (
        <section className="panel log-detail">
          <div className="panel-title">
            Entry detail
            <button type="button" className="ghost" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          <dl className="compact-list spaced">
            <div>
              <dt>Time</dt>
              <dd className="mono">{selected.ts}</dd>
            </div>
            <div>
              <dt>Level</dt>
              <dd>{selected.level}</dd>
            </div>
            <div>
              <dt>Request</dt>
              <dd className="mono">{selected.request_id ?? "—"}</dd>
            </div>
            <div>
              <dt>Campaign</dt>
              <dd className="mono">{selected.campaign_id ?? "—"}</dd>
            </div>
            <div>
              <dt>Component</dt>
              <dd className="mono">{selected.component ?? "—"}</dd>
            </div>
          </dl>
          <div className="log-message">{selected.message}</div>
          {selected.stack && <pre className="stack-trace">{selected.stack}</pre>}
          {selected.context && (
            <pre className="stack-trace">{JSON.stringify(selected.context, null, 2)}</pre>
          )}
        </section>
      )}
    </>
  );
}
