import { useEffect, useRef, useState } from "react";
import { api, type PublicApp, type WalletState } from "../api";
import { LinkStxButton } from "./LinkStx";
import { StxLogo } from "./PoweredByStx";
import { useLiveAccount } from "../liveAccount";
import { formatMoney } from "../publicMarketData";

// The dual wallet: the ISV app's OWN wallet (held here, the demo's mock balance)
// and the STX cash balance (real, pushed live over the member's STX socket), plus
// a combined total when the STX cash amount can be parsed. The STX side comes
// from the live feed, so trading makes no balance call; /api/wallet only supplies
// the app wallet (and the STX balance over REST if the live feed could not open).
// Deposit lives in the header; funds are added at STX, never touched by the ISV.
//
// Every amount is shown in full, "$100,000.00": a wallet never abbreviates.
// When the STX balance moves, a line under it says by how much ("▼ $24.75" in
// red, "▲ $12.40" in green) for four seconds, and the amount pulses once in the
// same colour. That line is always reserved, so the row never changes size. With reduced motion the chip and colour still show, without the
// animation.

// STX dollar string ("12.3400") to whole cents, or null.
function toCents(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

// How long the balance-change chip stays up.
const CHIP_MS = 4000;

interface Change {
  id: number;
  dir: "up" | "down";
  cents: number;
}

export function Wallets({
  app,
  linked,
  refreshKey,
}: {
  app: PublicApp;
  linked: boolean;
  refreshKey: number;
}) {
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [change, setChange] = useState<Change | null>(null);
  const prevCents = useRef<number | null | undefined>(undefined);
  const changeId = useRef(0);

  const liveAccount = useLiveAccount();
  // The live feed carries the balance unless it failed to open.
  const useLive = linked && !liveAccount.failed;

  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .wallet(useLive)
      .then((w) => alive && setWallet(w))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [refreshKey, linked, useLive]);

  // The STX cash: the live balance when the feed has one, else what
  // /api/wallet answered.
  const liveCents = useLive ? toCents(liveAccount.balance?.available_balance) : null;
  const cashCents = liveCents ?? wallet?.stx.cashCents ?? null;
  const appCents = wallet?.isv.walletCents ?? null;
  const combinedCents = appCents !== null && cashCents !== null ? appCents + cashCents : null;
  const rawBalance = liveCents !== null ? { balance: liveAccount.balance } : wallet?.stx.balance;
  const stxLinked = linked && wallet?.stx.linked;

  // When the STX balance changes (not on first load), show the signed change.
  useEffect(() => {
    const prev = prevCents.current;
    prevCents.current = cashCents;
    if (prev == null || cashCents == null || prev === cashCents || !stxLinked) return;
    changeId.current += 1;
    setChange({ id: changeId.current, dir: cashCents < prev ? "down" : "up", cents: Math.abs(cashCents - prev) });
  }, [cashCents, stxLinked]);
  useEffect(() => {
    if (!change) return;
    const t = setTimeout(() => setChange(null), CHIP_MS);
    return () => clearTimeout(t);
  }, [change]);

  return (
    <div className="card wallets">
      {error && <p className="error">{error}</p>}

      <dl className="wallet-list">
        <div className="wallet-line">
          <dt>
            <span className="wallet-dot" style={{ background: app.brandColor }} aria-hidden="true" />
            {app.name} wallet
          </dt>
          <dd className="wallet-amount">{wallet ? formatMoney(wallet.isv.walletDollars) : "–"}</dd>
        </div>

        <div className={`wallet-line wallet-line-stx${change ? ` moved-${change.dir}` : ""}`}>
          <dt>
            {/* The logo is the word STX (alt "STX"), so the row reads "STX balance". */}
            <StxLogo className="wallet-stx-logo" />
            balance
          </dt>
          {stxLinked ? (
            <dd className="wallet-amount-wrap">
              {/* Keys differ between the two spans: sharing one key made React
                  keep stale chips when the balance moved several times a second. */}
              <span key={`amount-${change?.id ?? 0}`} className={`wallet-amount${change ? ` pulse-${change.dir}` : ""}`}>
                {cashCents !== null ? formatMoney(cashCents / 100) : "–"}
              </span>
              <span className="balance-delta" role="status">
                {change && (
                  <span
                    key={`delta-${change.id}`}
                    className={`balance-chip balance-chip-${change.dir}`}
                    aria-label={`STX balance ${change.dir === "down" ? "down" : "up"} ${formatMoney(change.cents / 100)}`}
                  >
                    <span aria-hidden="true">{change.dir === "down" ? "▼" : "▲"}</span>
                    {formatMoney(change.cents / 100)}
                  </span>
                )}
              </span>
            </dd>
          ) : (
            <dd className="wallet-unlinked">Not linked</dd>
          )}
        </div>

        <div className="wallet-line wallet-line-total">
          <dt>Combined</dt>
          <dd className="wallet-amount">{combinedCents !== null && stxLinked ? formatMoney(combinedCents / 100) : "–"}</dd>
        </div>
      </dl>

      {!stxLinked && wallet && <LinkStxButton appName={app.name} block />}
      {stxLinked && (
        <p className="wallet-note">STX funds stay at STX. {app.name} never holds them.</p>
      )}
      {stxLinked && (
        <button type="button" className="link wallet-raw-toggle" onClick={() => setShowRaw((v) => !v)}>
          {/* A </> code mark: the raw balance is the API response. */}
          <svg className="wallet-raw-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M5.5 4 1.5 8l4 4M10.5 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{showRaw ? "Hide" : "Show"} raw STX balance</span>
        </button>
      )}
      {stxLinked && showRaw && <pre className="json">{JSON.stringify(rawBalance, null, 2)}</pre>}
    </div>
  );
}
