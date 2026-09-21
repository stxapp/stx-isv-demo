import { useState } from "react";
import { api, type PublicApp } from "../api";

// Mock sign-in to the ISV app. There is NO real auth here — this stands in for
// the user already being a Heater customer with their own account and
// wallet. Signing in creates that local user; linking STX comes afterwards.
export function SignIn({ app, onSignedIn }: { app: PublicApp; onSignedIn: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(name.trim() || undefined);
      onSignedIn();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card signin">
      <h3>Sign in to {app.name}</h3>
      <p className="muted">
        A mock {app.name} login — no password. It creates your {app.name} account and
        credits your {app.name} wallet. You link your STX exchange account after signing in.
      </p>
      <form className="signin-form" onSubmit={submit}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`Your name (optional) — defaults to "${app.name} demo user"`}
          aria-label="Display name"
        />
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : `Sign in to ${app.name}`}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
