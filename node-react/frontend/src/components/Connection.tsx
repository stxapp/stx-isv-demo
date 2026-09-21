import { useState } from "react";
import { api, type LinkState, type PublicApp } from "../api";

// The STX connection status, rendered in the header as a compact chip. When
// linked it shows "● Linked to STX" with an info toggle that drops down the
// scopes, the token-stays-on-the-backend note, and unlink. When not linked it
// renders nothing here — the link call-to-action lives in the wallet.
export function Connection({
  app,
  link,
  onChanged,
}: {
  app: PublicApp;
  link: LinkState;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  if (!link.connected) return null;

  async function unlink() {
    setBusy(true);
    setError(null);
    try {
      await api.unlink();
      setOpen(false);
      onChanged();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="conn-chip-wrap">
      <button
        type="button"
        className="conn-chip"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="dot dot-on" />
        <span className="conn-label">Linked to STX</span>
        <span className="conn-info" aria-hidden="true">ⓘ</span>
      </button>
      {open && (
        <div className="conn-pop">
          {link.linkedAt && (
            <p className="muted">Connected since {new Date(link.linkedAt).toLocaleString()}</p>
          )}
          <p className="muted">
            Scopes granted:{" "}
            <span className="scopes-inline">
              {link.scopes.length ? link.scopes.join(", ") : "(reported by STX)"}
            </span>
          </p>
          <p className="muted">
            The access token stays on {app.name}'s backend; this browser never sees it.
          </p>
          <button className="link danger" onClick={unlink} disabled={busy}>
            {busy ? "Unlinking…" : "Unlink STX account"}
          </button>
          {error && <p className="error">{error}</p>}
        </div>
      )}
    </div>
  );
}
