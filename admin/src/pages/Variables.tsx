import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import {
  createVariable,
  deleteVariable,
  fetchVariables,
  testVariable,
  updateVariable,
  validateVariable,
} from "../api";
import { AlertIcon, CheckIcon, SlidersIcon } from "../icons";
import type {
  AdminVariable,
  VariablePayload,
  VariableSource,
  VariableTestResult,
} from "../types";

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const SOURCE_OPTIONS: Array<[VariableSource, string]> = [
  ["field", "Field — copy a lookup column"],
  ["computed", "Concatenation — expression"],
  ["constant", "Constant — fixed value"],
  ["query", "SQL query — from the connected DB"],
  ["api", "API fetch — from an HTTP endpoint"],
];
const SOURCE_TONE: Record<VariableSource, string> = {
  field: "muted",
  computed: "amber",
  constant: "muted",
  query: "green",
  api: "green",
};
const isDynamic = (s: VariableSource) => s === "query" || s === "api";

function Badge({ tone = "muted", children }: { tone?: string; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

type HeaderRow = { key: string; value: string };
type ApiState = {
  method: "GET" | "POST";
  url: string;
  headers: HeaderRow[];
  json_path: string;
  body: string;
  timeout_ms: string;
};
type EditorState = {
  original?: string;
  name: string;
  source: VariableSource;
  field: string;
  expr: string;
  value: string;
  sql: string;
  api: ApiState;
  fallback: string;
  enabled: boolean;
};

const emptyApi = (): ApiState => ({ method: "GET", url: "", headers: [], json_path: "", body: "", timeout_ms: "" });

const emptyEditor = (): EditorState => ({
  name: "",
  source: "field",
  field: "",
  expr: "",
  value: "",
  sql: "",
  api: emptyApi(),
  fallback: "",
  enabled: true,
});

function toPayload(state: EditorState): VariablePayload {
  const base: VariablePayload = {
    name: state.name.trim(),
    source: state.source,
    ...(state.fallback !== "" ? { fallback: state.fallback } : {}),
    enabled: state.enabled,
  };
  switch (state.source) {
    case "field":
      return { ...base, field: state.field.trim() };
    case "computed":
      return { ...base, expr: state.expr.trim() };
    case "constant":
      return { ...base, value: state.value };
    case "query":
      return { ...base, sql: state.sql.trim() };
    case "api":
      return {
        ...base,
        api: {
          method: state.api.method,
          url: state.api.url.trim(),
          headers: Object.fromEntries(
            state.api.headers.filter((h) => h.key.trim()).map((h) => [h.key.trim(), h.value])
          ),
          json_path: state.api.json_path.trim(),
          ...(state.api.body.trim() ? { body: state.api.body } : {}),
          ...(state.api.timeout_ms.trim() ? { timeout_ms: Number(state.api.timeout_ms) } : {}),
        },
      };
  }
}

function variableToPayload(v: AdminVariable): VariablePayload {
  const cfg = (v.config ?? {}) as Record<string, unknown>;
  const base: VariablePayload = {
    name: v.name,
    source: v.source,
    ...(v.fallback !== null ? { fallback: v.fallback } : {}),
    enabled: v.enabled,
  };
  switch (v.source) {
    case "field":
      return { ...base, field: v.field ?? "" };
    case "computed":
      return { ...base, expr: v.expr ?? "" };
    case "constant":
      return { ...base, value: String(cfg.value ?? "") };
    case "query":
      return { ...base, sql: String(cfg.sql ?? "") };
    case "api":
      return {
        ...base,
        api: {
          method: (cfg.method as "GET" | "POST") ?? "GET",
          url: String(cfg.url ?? ""),
          headers: (cfg.headers as Record<string, string>) ?? {},
          json_path: String(cfg.json_path ?? ""),
          ...(cfg.body ? { body: String(cfg.body) } : {}),
          ...(cfg.timeout_ms ? { timeout_ms: Number(cfg.timeout_ms) } : {}),
        },
      };
  }
}

function editorFromVariable(v: AdminVariable): EditorState {
  const cfg = (v.config ?? {}) as Record<string, unknown>;
  const headers = (cfg.headers as Record<string, string> | undefined) ?? {};
  return {
    original: v.name,
    name: v.name,
    source: v.source,
    field: v.field ?? "",
    expr: v.expr ?? "",
    value: String(cfg.value ?? ""),
    sql: String(cfg.sql ?? ""),
    api: {
      method: (cfg.method as "GET" | "POST") ?? "GET",
      url: String(cfg.url ?? ""),
      headers: Object.entries(headers).map(([key, value]) => ({ key, value })),
      json_path: String(cfg.json_path ?? ""),
      body: String(cfg.body ?? ""),
      timeout_ms: cfg.timeout_ms ? String(cfg.timeout_ms) : "",
    },
    fallback: v.fallback ?? "",
    enabled: v.enabled,
  };
}

const TOKEN_HINT = "Tokens: {{user_id}} {{email}} {{campaign_id}} {{organization_id}}";

// --- REST-client style API builder -----------------------------------------

/** Split/join a URL's query string WITHOUT encoding, so {{tokens}} survive. */
function splitUrl(url: string): { base: string; params: HeaderRow[] } {
  const i = url.indexOf("?");
  if (i === -1) return { base: url, params: [] };
  const params = url
    .slice(i + 1)
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const e = pair.indexOf("=");
      return e === -1 ? { key: pair, value: "" } : { key: pair.slice(0, e), value: pair.slice(e + 1) };
    });
  return { base: url.slice(0, i), params };
}
function joinUrl(base: string, params: HeaderRow[]): string {
  const qs = params
    .filter((p) => p.key.trim())
    .map((p) => `${p.key}=${p.value}`)
    .join("&");
  return qs ? `${base}?${qs}` : base;
}

/** Walk a dotted path for the live "extracted value" readout. */
function extractPath(bodyText: string, path: string): string {
  let cur: unknown;
  try {
    cur = JSON.parse(bodyText);
  } catch {
    return "(response is not JSON)";
  }
  if (path.trim()) {
    for (const seg of path.split(".")) {
      if (cur === null || typeof cur !== "object") return "(not found)";
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  if (cur === undefined || cur === null) return "(not found)";
  return typeof cur === "object" ? JSON.stringify(cur) : String(cur);
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
const formatBytes = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

function KeyValueRows({
  rows,
  onChange,
  addLabel,
  keyPlaceholder,
  valuePlaceholder,
}: {
  rows: HeaderRow[];
  onChange: (next: HeaderRow[]) => void;
  addLabel: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  return (
    <div className="kv-rows">
      {rows.length === 0 && <div className="kv-empty">None yet.</div>}
      {rows.map((r, i) => (
        <div className="kv-row" key={i}>
          <input
            placeholder={keyPlaceholder}
            value={r.key}
            onChange={(e) => {
              const next = [...rows];
              next[i] = { ...r, key: e.target.value };
              onChange(next);
            }}
          />
          <input
            placeholder={valuePlaceholder}
            value={r.value}
            onChange={(e) => {
              const next = [...rows];
              next[i] = { ...r, value: e.target.value };
              onChange(next);
            }}
          />
          <button type="button" className="ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="ghost kv-add" onClick={() => onChange([...rows, { key: "", value: "" }])}>
        {addLabel}
      </button>
    </div>
  );
}

type ReqTab = "params" | "headers" | "body" | "settings";

function ApiBuilder({
  api,
  onChange,
  onSend,
  sending,
  result,
}: {
  api: ApiState;
  onChange: (patch: Partial<ApiState>) => void;
  onSend: () => void;
  sending: boolean;
  result: VariableTestResult | null;
}) {
  const [tab, setTab] = useState<ReqTab>("params");
  const { base, params } = splitUrl(api.url);
  const res = result?.response;

  return (
    <div className="api-client">
      {/* Method + URL + Send — the request bar */}
      <div className="req-bar">
        <select
          className="req-method"
          value={api.method}
          onChange={(e) => onChange({ method: e.target.value as "GET" | "POST" })}
        >
          <option value="GET">GET</option>
          <option value="POST">POST</option>
        </select>
        <input
          className="req-url"
          value={api.url}
          onChange={(e) => onChange({ url: e.target.value })}
          placeholder="https://crm.example.com/users/{{user_id}}"
          spellCheck={false}
          required
        />
        <button type="button" className="req-send" onClick={onSend} disabled={sending}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
      <div className="req-hint">
        Tokens resolve per recipient: <code>{"{{user_id}}"}</code> <code>{"{{email}}"}</code>{" "}
        <code>{"{{campaign_id}}"}</code> <code>{"{{field.NAME}}"}</code>
      </div>

      {/* Request tabs */}
      <div className="req-tabs">
        {(
          [
            ["params", "Params", params.length],
            ["headers", "Headers", api.headers.length],
            ["body", "Body", api.body.trim() ? 1 : 0],
            ["settings", "Settings", 0],
          ] as Array<[ReqTab, string, number]>
        ).map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            className={`req-tab ${tab === id ? "active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
            {count > 0 && <span className="tab-badge">{count}</span>}
          </button>
        ))}
      </div>

      <div className="req-panel">
        {tab === "params" && (
          <KeyValueRows
            rows={params}
            onChange={(next) => onChange({ url: joinUrl(base, next) })}
            addLabel="+ Add query param"
            keyPlaceholder="tier"
            valuePlaceholder="{{user_id}}"
          />
        )}
        {tab === "headers" && (
          <KeyValueRows
            rows={api.headers}
            onChange={(headers) => onChange({ headers })}
            addLabel="+ Add header"
            keyPlaceholder="Authorization"
            valuePlaceholder="Bearer …"
          />
        )}
        {tab === "body" && (
          <>
            {api.method === "GET" && <div className="kv-empty">GET requests are sent without a body.</div>}
            <textarea
              className="code-input"
              rows={5}
              value={api.body}
              onChange={(e) => onChange({ body: e.target.value })}
              placeholder={'{\n  "user": "{{user_id}}"\n}'}
              disabled={api.method === "GET"}
              spellCheck={false}
            />
          </>
        )}
        {tab === "settings" && (
          <label className="field-row settings-row">
            Timeout (ms) <span className="field-hint">default 5000, max 30000</span>
            <input
              value={api.timeout_ms}
              onChange={(e) => onChange({ timeout_ms: e.target.value.replace(/[^0-9]/g, "") })}
              placeholder="5000"
            />
          </label>
        )}
      </div>

      {/* Response pane */}
      {(res || result?.error) && (
        <div className="res-pane">
          <div className="res-head">
            <span className="res-title">Response</span>
            {res && (
              <>
                <span className={`badge badge-${res.ok ? "green" : "red"}`}>{res.status}</span>
                <span className="res-meta">{res.time_ms} ms</span>
                <span className="res-meta">{formatBytes(res.size)}</span>
              </>
            )}
            {!res && result?.error && <span className="badge badge-red">error</span>}
          </div>
          {result?.error && !res && <div className="login-error"><AlertIcon />{result.error}</div>}
          {res && <pre className="res-body">{prettyJson(res.body)}</pre>}
          {res && (
            <div className="res-extract">
              <label>
                JSON path
                <input
                  value={api.json_path}
                  onChange={(e) => onChange({ json_path: e.target.value })}
                  placeholder="data.tier"
                  spellCheck={false}
                />
              </label>
              <div className="res-value">
                <CheckIcon /> Resolves to <code>{extractPath(res.body, api.json_path) || "(empty)"}</code>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Editor({
  state,
  onChange,
  onCancel,
  onSaved,
}: {
  state: EditorState;
  onChange: (next: EditorState) => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<VariableTestResult | null>(null);
  const setApi = (patch: Partial<ApiState>) => onChange({ ...state, api: { ...state.api, ...patch } });

  const runValidation = async () => {
    setError("");
    setPreview(null);
    if (!NAME_RE.test(state.name.trim())) {
      setError("Name must start with a letter/underscore and use only letters, digits, underscores.");
      return false;
    }
    try {
      const result = await validateVariable(toPayload(state));
      if (!result.ok) {
        setError(result.error ?? "Invalid definition");
        return false;
      }
      if (result.preview !== undefined) setPreview(result.preview);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Validation failed");
      return false;
    }
  };

  const runTest = async () => {
    setTestResult(null);
    setError("");
    setSending(true);
    try {
      setTestResult(await testVariable(toPayload(state)));
    } catch (reason) {
      setTestResult({ ok: false, error: reason instanceof Error ? reason.message : "Test failed" });
    } finally {
      setSending(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      if (!(await runValidation())) return;
      const payload = toPayload(state);
      if (state.original) await updateVariable(state.original, payload);
      else await createVariable(payload);
      toast.success(
        state.original ? `Variable {{${payload.name}}} updated` : `Variable {{${payload.name}}} created`,
        { description: "Applies to the next dispatch — no restart needed." }
      );
      onSaved();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Unable to save variable";
      setError(message);
      toast.error("Could not save variable", { description: message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel variable-editor">
      <div className="panel-title">
        <SlidersIcon /> {state.original ? `Edit {{${state.original}}}` : "New variable"}
      </div>
      <form onSubmit={(event) => void submit(event)}>
        <div className="form-grid">
          <label>
            Name
            <input
              value={state.name}
              onChange={(event) => onChange({ ...state, name: event.target.value })}
              placeholder="loyalty_tier"
              required
            />
          </label>
          <label>
            Source
            <select
              value={state.source}
              onChange={(event) => onChange({ ...state, source: event.target.value as VariableSource })}
            >
              {SOURCE_OPTIONS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {state.source === "field" && (
          <label className="field-row">
            Field
            <input
              value={state.field}
              onChange={(event) => onChange({ ...state, field: event.target.value })}
              placeholder="first_name"
              required
            />
          </label>
        )}
        {state.source === "computed" && (
          <label className="field-row">
            Expression
            <input
              value={state.expr}
              onChange={(event) => onChange({ ...state, expr: event.target.value })}
              onBlur={() => void runValidation()}
              placeholder="'Hello ' + first_name + ' from ' + company_name"
              required
            />
          </label>
        )}
        {state.source === "constant" && (
          <label className="field-row">
            Constant value
            <input
              value={state.value}
              onChange={(event) => onChange({ ...state, value: event.target.value })}
              placeholder="Winter Sale 2026"
            />
          </label>
        )}
        {state.source === "query" && (
          <label className="field-row">
            SQL query <span className="field-hint">{TOKEN_HINT}</span>
            <textarea
              className="code-input"
              rows={3}
              value={state.sql}
              onChange={(event) => onChange({ ...state, sql: event.target.value })}
              placeholder="SELECT tier FROM loyalty WHERE user_id = {{user_id}}"
              required
            />
          </label>
        )}
        {state.source === "api" && (
          <ApiBuilder
            api={state.api}
            onChange={setApi}
            onSend={() => void runTest()}
            sending={sending}
            result={testResult}
          />
        )}

        <label className="field-row">
          Fallback <span className="field-hint">used when the value is empty or resolution fails</span>
          <input
            value={state.fallback}
            onChange={(event) => onChange({ ...state, fallback: event.target.value })}
            placeholder="there"
          />
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            checked={state.enabled}
            onChange={(event) => onChange({ ...state, enabled: event.target.checked })}
          />
          Enabled
        </label>

        {error && (
          <div className="login-error">
            <AlertIcon />
            {error}
          </div>
        )}
        {preview !== null && !error && (
          <div className="variable-preview">
            <CheckIcon /> Sample render: <code>{preview || "(empty)"}</code>
          </div>
        )}
        {/* api renders its own response pane inside the builder */}
        {testResult && state.source !== "api" && (
          <div className={testResult.ok ? "variable-preview" : "login-error"}>
            {testResult.ok ? <CheckIcon /> : <AlertIcon />}
            {testResult.ok ? (
              <>
                Test result: <code>{testResult.value || "(empty — fallback used)"}</code>
              </>
            ) : (
              testResult.error
            )}
          </div>
        )}
        <div className="editor-actions">
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : state.original ? "Save changes" : "Create variable"}
          </button>
          {state.source === "query" && (
            <button type="button" className="ghost" onClick={() => void runTest()} disabled={busy || sending}>
              {sending ? "Testing…" : "Test"}
            </button>
          )}
          <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

function definitionSummary(v: AdminVariable): string {
  const cfg = (v.config ?? {}) as Record<string, unknown>;
  switch (v.source) {
    case "field":
      return v.field ?? "";
    case "computed":
      return v.expr ?? "";
    case "constant":
      return String(cfg.value ?? "");
    case "query":
      return String(cfg.sql ?? "");
    case "api":
      return `${String(cfg.method ?? "GET")} ${String(cfg.url ?? "")}`;
  }
}

export default function Variables({ refreshSignal = 0 }: { refreshSignal?: number }) {
  const [variables, setVariables] = useState<AdminVariable[] | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const data = await fetchVariables();
      setVariables(data.variables);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Unable to load variables";
      setError(message);
      toast.error("Could not load variables", { description: message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  const toggle = async (variable: AdminVariable) => {
    try {
      await updateVariable(variable.name, { ...variableToPayload(variable), enabled: !variable.enabled });
      toast.success(`{{${variable.name}}} ${variable.enabled ? "disabled" : "enabled"}`);
      await load();
    } catch (reason) {
      toast.error("Could not update variable", {
        description: reason instanceof Error ? reason.message : undefined,
      });
    }
  };

  const remove = async (name: string) => {
    try {
      await deleteVariable(name);
      setPendingDelete(null);
      toast.success(`Variable {{${name}}} deleted`);
      await load();
    } catch (reason) {
      toast.error("Could not delete variable", {
        description: reason instanceof Error ? reason.message : undefined,
      });
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Dynamic variables</h1>
          <p>
            Personalization placeholders live in the dispatcher database. Pull values from a lookup
            field, an expression, a constant, a SQL query, or an API — changes apply to the next
            dispatch with no restart.
          </p>
        </div>
        <div className="head-actions">
          <button type="button" onClick={() => setEditor(emptyEditor())}>
            New variable
          </button>
        </div>
      </header>
      {error && (
        <div className="error-state">
          <AlertIcon />
          <strong>Variables</strong>
          <p>{error}</p>
        </div>
      )}
      {editor && (
        <Editor
          state={editor}
          onChange={setEditor}
          onCancel={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            void load();
          }}
        />
      )}
      {variables && variables.length === 0 && !editor && (
        <div className="empty-state">
          <SlidersIcon />
          <strong>No variables defined</strong>
          <span>Create one to start personalizing content with {"{{placeholders}}"}.</span>
        </div>
      )}
      {variables && variables.length > 0 && (
        <section className="table-wrap scroll-x">
          <table className="variables-table">
            <thead>
              <tr>
                <th>Placeholder</th>
                <th>Source</th>
                <th>Definition</th>
                <th>Sample</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {variables.map((variable) => {
                const summary = definitionSummary(variable);
                return (
                  <tr key={variable.name} className={variable.enabled ? "" : "row-muted"}>
                    <td className="mono">{`{{${variable.name}}}`}</td>
                    <td>
                      <Badge tone={SOURCE_TONE[variable.source]}>{variable.source}</Badge>
                    </td>
                    <td className="mono definition-cell" title={summary}>
                      {summary}
                    </td>
                    <td className="mono preview-cell" title={variable.preview}>
                      {isDynamic(variable.source) ? (
                        <span className="faint-hint">test to preview</span>
                      ) : (
                        variable.preview || "—"
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className={`badge badge-${variable.enabled ? "green" : "muted"} status-toggle`}
                        onClick={() => void toggle(variable)}
                        title={variable.enabled ? "Click to disable" : "Click to enable"}
                      >
                        {variable.enabled ? "enabled" : "disabled"}
                      </button>
                    </td>
                    <td className="actions-cell">
                      <button type="button" className="ghost" onClick={() => setEditor(editorFromVariable(variable))}>
                        Edit
                      </button>
                      {pendingDelete === variable.name ? (
                        <>
                          <button type="button" className="danger" onClick={() => void remove(variable.name)}>
                            Confirm
                          </button>
                          <button type="button" className="ghost" onClick={() => setPendingDelete(null)}>
                            Keep
                          </button>
                        </>
                      ) : (
                        <button type="button" className="ghost" onClick={() => setPendingDelete(variable.name)}>
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
