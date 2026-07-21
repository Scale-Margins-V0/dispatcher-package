import { useState, type FormEvent } from "react";
import { acceptInvite } from "../api";
import { AlertIcon, CheckIcon, ShieldIcon } from "../icons";

function tokenFromHash(): string {
  const query = window.location.hash.split("?")[1] ?? "";
  return new URLSearchParams(query).get("token") ?? "";
}

export default function AcceptInvite() {
  const [token] = useState(tokenFromHash);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (password.length < 12) {
      setError("Password must be at least 12 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Password and confirmation do not match.");
      return;
    }
    setBusy(true);
    try {
      await acceptInvite(token, name.trim(), password);
      setDone(true);
      // Signed in via the accept response; drop into the console.
      window.location.hash = "overview";
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to accept the invitation");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="login-mark">SM</div>
        <div className="eyebrow">Operator console</div>
        <h1>Accept your invitation</h1>
        {!token ? (
          <p>This invitation link is missing its token. Ask your administrator for a fresh link.</p>
        ) : done ? (
          <div className="variable-preview">
            <CheckIcon /> Account created. Taking you to the console…
          </div>
        ) : (
          <>
            <p>Set your name and a password to join the ScaleMargin dispatcher.</p>
            <form onSubmit={(e) => void submit(e)}>
              <label>
                Full name
                <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
              </label>
              <label>
                Password
                <input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
              <label>
                Confirm password
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                />
              </label>
              {error && (
                <div className="login-error">
                  <AlertIcon />
                  {error}
                </div>
              )}
              <button type="submit" disabled={busy}>
                {busy ? "Creating account…" : "Create account & join"}
              </button>
            </form>
          </>
        )}
        <div className="login-foot">
          <ShieldIcon />
          Invitation links expire and can be used once
        </div>
      </section>
    </main>
  );
}
