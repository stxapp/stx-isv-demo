import { track } from "../analytics";
import { useState } from "react";
import { api, type PublicApp } from "../api";

// Mock sign-in to the ISV app. There is NO real auth here: it stands in for the
// user already being a Sideline customer with their own account and wallet.
// Signing in creates that local user; linking STX comes afterwards. Sideline is
// fictional, and the card says so.
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
      track("sign_in");
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
      <p className="fiction-note">
        {app.name} is a fictional sports app used to demonstrate building on STX. It is not a
        real product or company.
      </p>
      <p className="muted">
        This is a mock {app.name} login with no password. It creates a demo {app.name} account
        and wallet. You link your STX exchange account after signing in.
      </p>
      <form className="signin-form" onSubmit={submit}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`Your name (optional), or "${app.name} demo user"`}
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
