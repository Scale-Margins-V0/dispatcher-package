import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  createVariable,
  deleteVariable,
  fetchVariables,
  testVariable,
  updateVariable,
  validateVariable,
} from "../api";
import { AlertIcon, CheckIcon, SlidersIcon } from "../icons";
import type { AdminVariable, VariablePayload, VariableSource } from "../types";

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
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
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
    try {
      const r = await testVariable(toPayload(state));
      setTestResult(
        r.ok
          ? { ok: true, text: r.value && r.value.length > 0 ? r.value : "(empty — fallback used)" }
          : { ok: false, text: r.error ?? "Test failed" }
      );
    } catch (reason) {
      setTestResult({ ok: false, text: reason instanceof Error ? reason.message : "Test failed" });
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
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save variable");
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
          <div className="api-form">
            <div className="api-row">
              <label className="api-method">
                Method
                <select
                  value={state.api.method}
                  onChange={(event) => setApi({ method: event.target.value as "GET" | "POST" })}
                >
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                </select>
              </label>
              <label className="api-url">
                URL <span className="field-hint">tokens allowed, {"{{field.NAME}}"} too</span>
                <input
                  value={state.api.url}
                  onChange={(event) => setApi({ url: event.target.value })}
                  placeholder="https://crm.example.com/users/{{user_id}}"
                  required
                />
              </label>
            </div>
            <div className="api-headers">
              <div className="field-label-row">
                <span>Headers</span>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setApi({ headers: [...state.api.headers, { key: "", value: "" }] })}
                >
                  + Add header
                </button>
              </div>
              {state.api.headers.map((h, i) => (
                <div className="header-row" key={i}>
                  <input
                    placeholder="Authorization"
                    value={h.key}
                    onChange={(event) => {
                      const headers = [...state.api.headers];
                      headers[i] = { ...h, key: event.target.value };
                      setApi({ headers });
                    }}
                  />
                  <input
                    placeholder="Bearer …"
                    value={h.value}
                    onChange={(event) => {
                      const headers = [...state.api.headers];
                      headers[i] = { ...h, value: event.target.value };
                      setApi({ headers });
                    }}
                  />
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setApi({ headers: state.api.headers.filter((_, j) => j !== i) })}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <div className="api-row">
              <label className="api-jsonpath">
                JSON path
                <input
                  value={state.api.json_path}
                  onChange={(event) => setApi({ json_path: event.target.value })}
                  placeholder="data.tier"
                />
              </label>
              <label className="api-timeout">
                Timeout (ms)
                <input
                  value={state.api.timeout_ms}
                  onChange={(event) => setApi({ timeout_ms: event.target.value.replace(/[^0-9]/g, "") })}
                  placeholder="5000"
                />
              </label>
            </div>
            {state.api.method === "POST" && (
              <label className="field-row">
                Request body
                <textarea
                  className="code-input"
                  rows={2}
                  value={state.api.body}
                  onChange={(event) => setApi({ body: event.target.value })}
                  placeholder='{"user":"{{user_id}}"}'
                />
              </label>
            )}
          </div>
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
        {testResult && (
          <div className={testResult.ok ? "variable-preview" : "login-error"}>
            {testResult.ok ? <CheckIcon /> : <AlertIcon />} {testResult.ok ? "Test result: " : ""}
            <code>{testResult.text}</code>
          </div>
        )}
        <div className="editor-actions">
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : state.original ? "Save changes" : "Create variable"}
          </button>
          {isDynamic(state.source) && (
            <button type="button" className="ghost" onClick={() => void runTest()} disabled={busy}>
              Test
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
      setError(reason instanceof Error ? reason.message : "Unable to load variables");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  const toggle = async (variable: AdminVariable) => {
    try {
      await updateVariable(variable.name, { ...variableToPayload(variable), enabled: !variable.enabled });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to update variable");
    }
  };

  const remove = async (name: string) => {
    try {
      await deleteVariable(name);
      setPendingDelete(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to delete variable");
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
