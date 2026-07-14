import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  createVariable,
  deleteVariable,
  fetchVariables,
  updateVariable,
  validateVariable,
} from "../api";
import { AlertIcon, CheckIcon, RefreshIcon, SlidersIcon } from "../icons";
import type { AdminVariable, VariablePayload } from "../types";

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function Badge({ tone = "muted", children }: { tone?: string; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

type EditorState = {
  original?: string; // name being edited; undefined = create
  name: string;
  source: "field" | "computed";
  field: string;
  expr: string;
  fallback: string;
  enabled: boolean;
};

const emptyEditor = (): EditorState => ({
  name: "",
  source: "field",
  field: "",
  expr: "",
  fallback: "",
  enabled: true,
});

const toPayload = (state: EditorState): VariablePayload => ({
  name: state.name.trim(),
  source: state.source,
  ...(state.source === "field" ? { field: state.field.trim() } : {}),
  ...(state.source === "computed" ? { expr: state.expr.trim() } : {}),
  ...(state.fallback !== "" ? { fallback: state.fallback } : {}),
  enabled: state.enabled,
});

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
      setPreview(result.preview ?? null);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Validation failed");
      return false;
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
              placeholder="first_name"
              required
            />
          </label>
          <label>
            Source
            <select
              value={state.source}
              onChange={(event) =>
                onChange({ ...state, source: event.target.value as "field" | "computed" })
              }
            >
              <option value="field">field — copy a user lookup column</option>
              <option value="computed">computed — concat expression</option>
            </select>
          </label>
          {state.source === "field" ? (
            <label>
              Field
              <input
                value={state.field}
                onChange={(event) => onChange({ ...state, field: event.target.value })}
                placeholder="first_name"
                required
              />
            </label>
          ) : (
            <label className="wide">
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
          <label>
            Fallback
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
        </div>
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
        <div className="editor-actions">
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : state.original ? "Save changes" : "Create variable"}
          </button>
          <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

export default function Variables() {
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
  }, [load]);

  const edit = (variable: AdminVariable) =>
    setEditor({
      original: variable.name,
      name: variable.name,
      source: variable.source,
      field: variable.field ?? "",
      expr: variable.expr ?? "",
      fallback: variable.fallback ?? "",
      enabled: variable.enabled,
    });

  const toggle = async (variable: AdminVariable) => {
    try {
      await updateVariable(variable.name, {
        name: variable.name,
        source: variable.source,
        ...(variable.source === "field" ? { field: variable.field ?? "" } : {}),
        ...(variable.source === "computed" ? { expr: variable.expr ?? "" } : {}),
        ...(variable.fallback !== null ? { fallback: variable.fallback } : {}),
        enabled: !variable.enabled,
      });
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
            Personalization placeholders live in the dispatcher database. Changes apply to the
            next dispatch immediately — no redeploy, no restart.
          </p>
        </div>
        <div className="head-actions">
          <button type="button" className="refresh-button" onClick={() => void load()}>
            <RefreshIcon /> Refresh
          </button>
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
        <section className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Placeholder</th>
                <th>Source</th>
                <th>Definition</th>
                <th>Fallback</th>
                <th>Sample</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {variables.map((variable) => (
                <tr key={variable.name} className={variable.enabled ? "" : "row-muted"}>
                  <td className="mono">{`{{${variable.name}}}`}</td>
                  <td>
                    <Badge tone={variable.source === "computed" ? "amber" : "muted"}>
                      {variable.source}
                    </Badge>
                  </td>
                  <td className="mono definition-cell">
                    {variable.source === "field" ? variable.field : variable.expr}
                  </td>
                  <td>{variable.fallback ?? "—"}</td>
                  <td className="mono">{variable.preview || "—"}</td>
                  <td>
                    <Badge tone={variable.enabled ? "green" : "muted"}>
                      {variable.enabled ? "enabled" : "disabled"}
                    </Badge>
                  </td>
                  <td className="actions-cell">
                    <button type="button" className="ghost" onClick={() => edit(variable)}>
                      Edit
                    </button>
                    <button type="button" className="ghost" onClick={() => void toggle(variable)}>
                      {variable.enabled ? "Disable" : "Enable"}
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
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
