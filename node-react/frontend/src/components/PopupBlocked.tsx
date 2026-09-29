import { useEffect, useState } from "react";
import { openStxPopup, POPUP_BLOCKED_EVENT, type StxPopupRequest } from "../api";
import { track } from "../analytics";
import { Dialog } from "./Dialog";

// When the browser blocks an STX popup, the page stays where it is and this
// asks once more. The button is a fresh click, which popup blockers allow.
// If that is blocked too, the member can allow popups or continue in this tab.
export function PopupBlocked() {
  const [req, setReq] = useState<StxPopupRequest | null>(null);
  const [retried, setRetried] = useState(false);

  useEffect(() => {
    function onBlocked(e: Event) {
      track("popup_blocked");
      setReq((e as CustomEvent<StxPopupRequest>).detail);
      setRetried(false);
    }
    window.addEventListener(POPUP_BLOCKED_EVENT, onBlocked);
    return () => window.removeEventListener(POPUP_BLOCKED_EVENT, onBlocked);
  }, []);

  function close() {
    setReq(null);
  }

  function retry() {
    if (!req) return;
    // The retry's own block would reopen this dialog: close first.
    const r = req;
    close();
    if (!openStxPopup(r.url, r.name, r.size)) setRetried(true);
  }

  return (
    <Dialog open={req !== null} onClose={close} labelledBy="popup-blocked-title">
      <h2 id="popup-blocked-title" className="modal-title">Open STX in a new window</h2>
      <p className="modal-body">
        {retried
          ? "Your browser blocked the STX window again. Allow pop-ups for this site, or continue to STX in this tab."
          : "Your browser stopped the STX window from opening. STX opens in its own window so you stay on this page."}
      </p>
      <div className="modal-actions">
        <button type="button" className="modal-secondary" onClick={close}>
          Cancel
        </button>
        {retried && req ? (
          <a className="modal-secondary" href={req.url}>
            Continue in this tab
          </a>
        ) : null}
        <button type="button" className="modal-primary" onClick={retry} autoFocus>
          Open STX
        </button>
      </div>
    </Dialog>
  );
}
