import { useEffect, useId, useRef, useState } from "react";
import { api, type DemoUser, type LinkState, type PublicApp } from "../api";

// The signed-in user's menu in the header: one round avatar button that opens
// a panel with who is signed in, the STX link (status, scopes, unlink) and
// Sign out. It replaces the separate "Linked to STX" chip and name / Sign out
// stack, so the header keeps one primary action (Deposit) and small icons.

// A stable hue per user, so the same name always gets the same colour.
function hueOf(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

// "mike1" -> "M", "Sideline demo user" -> "SD".
function initialsOf(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length > 1 ? words[0][0] + words[1][0] : words[0][0];
  return letters.toUpperCase();
}

// Initials on a colour made from the name: drawn here, no image host.
export function Avatar({ name, size = "md" }: { name: string; size?: "md" | "lg" }) {
  return (
    <span
      className={`avatar avatar-${size}`}
      style={{ ["--avatar-hue" as string]: String(hueOf(name)) } as React.CSSProperties}
      aria-hidden="true"
    >
      {initialsOf(name)}
    </span>
  );
}

export function AccountMenu({
  app,
  user,
  link,
  onChanged,
  onSignOut,
}: {
  app: PublicApp;
  user: DemoUser;
  link: LinkState;
  onChanged: () => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // Close on a click outside or Escape (focus goes back to the button).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function unlink() {
    setBusy(true);
    setError(null);
    try {
      await api.unlink();
      onChanged();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="account" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="account-btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Account: ${user.name}${link.connected ? ", linked to STX" : ""}`}
        title={user.name}
      >
        <Avatar name={user.name} />
        {link.connected && <span className="account-linked-dot" aria-hidden="true" />}
        <span className="account-name">{user.name}</span>
        <span className="account-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="account-pop" id={panelId}>
          <div className="account-who">
            <Avatar name={user.name} size="lg" />
            <div className="account-who-text">
              <span className="account-who-name">{user.name}</span>
              {user.email && user.email !== user.name && <span className="muted">{user.email}</span>}
              <span className="muted">Signed in to {app.name}</span>
            </div>
          </div>

          <div className="account-section">
            {link.connected ? (
              <>
                <p className="account-status">
                  <span className="dot dot-on" aria-hidden="true" /> Linked to STX
                </p>
                {link.linkedAt && (
                  <p className="muted">Since {new Date(link.linkedAt).toLocaleString()}</p>
                )}
                <p className="muted">
                  Scopes: <span className="scopes-inline">{link.scopes.length ? link.scopes.join(", ") : "(reported by STX)"}</span>
                </p>
                <p className="muted">The access token stays on {app.name}'s backend; this browser never sees it.</p>
                <button type="button" className="unlink-btn" onClick={unlink} disabled={busy}>
                  {busy ? "Disconnecting…" : "Disconnect STX account"}
                </button>
                {error && <p className="error">{error}</p>}
              </>
            ) : (
              <>
                <p className="account-status">
                  <span className="dot" aria-hidden="true" /> Not linked to STX
                </p>
                <p className="muted">Link your STX account from the wallet to trade.</p>
              </>
            )}
          </div>

          <button
            type="button"
            className="account-signout"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
