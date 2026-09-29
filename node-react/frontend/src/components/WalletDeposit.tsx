import { useEffect, useState } from "react";
import { api, ApiError, type PublicApp } from "../api";
import { track } from "../analytics";
import { Dialog } from "./Dialog";

const AMOUNTS = [25, 50, 100, 250];

// Top up the app's OWN wallet (demo funds, no payment). This is the header's
// Deposit: STX funds are added at STX, from the STX line of the wallet card.
export function WalletDeposit({
  app,
  open,
  onClose,
  onDeposited,
}: {
  app: PublicApp;
  open: boolean;
  onClose: () => void;
  onDeposited: () => void;
}) {
  const [dollars, setDollars] = useState(AMOUNTS[1]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.addFunds(dollars * 100);
      track("wallet_topup", { dollars });
      onDeposited();
      onClose();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { message?: string } | null) : null;
      setError(body?.message ?? "Could not add funds. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} labelledBy="wallet-deposit-title">
      <h2 id="wallet-deposit-title" className="modal-title">
        <span className="wallet-dot" style={{ background: app.brandColor }} aria-hidden="true" />
        Add funds to your {app.name} wallet
      </h2>
      <div className="amount-picks" role="radiogroup" aria-label="Amount">
        {AMOUNTS.map((a) => (
          <button
            key={a}
            type="button"
            role="radio"
            aria-checked={dollars === a}
            className={`amount-pick${dollars === a ? " active" : ""}`}
            onClick={() => setDollars(a)}
          >
            ${a}
          </button>
        ))}
      </div>
      <p className="modal-note">Demo funds. No payment is taken.</p>
      <p className="modal-note">
        To add money to your STX account, use <strong>Add funds</strong> on the STX balance in your wallet.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="modal-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="modal-primary" onClick={submit} disabled={busy} autoFocus>
          {busy ? "Adding…" : `Add $${dollars}`}
        </button>
      </div>
    </Dialog>
  );
}
