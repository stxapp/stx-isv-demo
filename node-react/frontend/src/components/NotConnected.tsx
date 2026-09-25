// Shown wherever a member view needs a linked STX account but the call came
// back 401/not_linked: a clear "connect STX" state instead of a raw error code.
// The member links from the account panel (right column), so this only explains;
// it does not itself start the OAuth flow.
export function NotConnected({ what = "this" }: { what?: string }) {
  return (
    <div className="not-connected">
      <span className="not-connected-dot" aria-hidden="true">
        ●
      </span>
      <p className="not-connected-title">STX account not connected</p>
      <p className="muted">
        Sign in and link your STX account to see {what}. Your session may have
        also expired: reconnect from the account panel.
      </p>
    </div>
  );
}
