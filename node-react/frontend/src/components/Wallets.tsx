import { useEffect, useRef, useState } from "react";
import { api, startLink, type PublicApp, type WalletState } from "../api";
import { compactMoney, moneyTitle } from "../publicMarketData";

// The dual-wallet view, compact: the ISV app's OWN wallet (held here, the demo's
// mock balance) alongside the STX cash balance (real, fetched live via the link),
// plus a combined total when the STX cash amount can be parsed. When the STX
// balance changes (e.g. an order fills and the live feed nudges a refetch) the
// amount flashes, so the real-time change is visible. Deposit lives in the
// header now; funds are added at STX, never touched by the ISV.

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
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  // The signed change on the last STX-balance update, shown as a floating chip so
  // a real-time credit/debit is unmissable, not just a colour blip.
  const [delta, setDelta] = useState<{ text: string; dir: "up" | "down"; id: number } | null>(null);
  const prevCash = useRef<string | null | undefined>(undefined);
  const prevCashNum = useRef<number | null>(null);
  const deltaId = useRef(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .wallet()
      .then((w) => alive && setWallet(w))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [refreshKey, linked]);

  // When the STX balance changes (not on first load), pulse the amount in the
  // direction of the change and float a +/− delta chip.
  useEffect(() => {
    const cash = wallet?.stx.cashDollars ?? null;
    const cashNum = cash != null ? parseFloat(cash) : null;
    if (prevCash.current !== undefined && cash !== prevCash.current && wallet?.stx.linked) {
      const prev = prevCashNum.current;
      const diff = prev != null && cashNum != null ? cashNum - prev : null;
      const dir: "up" | "down" = diff != null && diff < 0 ? "down" : "up";
      setFlash(dir);
      if (diff != null && Math.abs(diff) >= 0.005) {
        deltaId.current += 1;
        setDelta({
          text: `${diff > 0 ? "+" : "−"}${compactMoney(String(Math.abs(diff)))}`,
          dir,
          id: deltaId.current,
        });
      }
    }
    prevCash.current = cash;
    if (cashNum != null && Number.isFinite(cashNum)) prevCashNum.current = cashNum;
  }, [wallet]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1300);
    return () => clearTimeout(t);
  }, [flash]);
  useEffect(() => {
    if (!delta) return;
    const t = setTimeout(() => setDelta(null), 2400);
    return () => clearTimeout(t);
  }, [delta]);

  const stxLinked = linked && wallet?.stx.linked;

  return (
    <div className="card wallets wallets-compact">
      {error && <p className="error">{error}</p>}

      <div className="wallet-row">
        <div className="wallet wallet-heater" style={{ borderColor: app.brandColor }}>
          <span className="wallet-label" style={{ color: app.brandColor }}>{app.name}</span>
          <span className="wallet-amount" title={moneyTitle(wallet?.heater.walletDollars)}>
            {wallet ? compactMoney(wallet.heater.walletDollars) : "—"}
          </span>
        </div>

        <span className="wallet-op">+</span>

        <div className={`wallet wallet-stx${flash ? ` pulse pulse-${flash}` : ""}`}>
          {delta && (
            <span key={delta.id} className={`wallet-delta wallet-delta-${delta.dir}`}>
              {delta.dir === "up" ? "▲" : "▼"} {delta.text}
            </span>
          )}
          <span className="wallet-label">STX</span>
          {stxLinked ? (
            <span
              className={`wallet-amount${flash ? ` flash flash-${flash}` : ""}`}
              title={moneyTitle(wallet?.stx.cashDollars)}
            >
              {compactMoney(wallet?.stx.cashDollars)}
            </span>
          ) : (
            <button className="link wallet-link" onClick={startLink}>
              Link STX
            </button>
          )}
        </div>

        <span className="wallet-op">=</span>

        <div className="wallet wallet-total">
          <span className="wallet-label">Combined</span>
          <span className="wallet-amount" title={moneyTitle(wallet?.combinedDollars)}>
            {wallet?.combinedDollars ? compactMoney(wallet.combinedDollars) : "—"}
          </span>
        </div>
      </div>

      {stxLinked && (
        <button className="link wallet-raw-toggle" onClick={() => setShowRaw((v) => !v)}>
          {showRaw ? "Hide" : "Show"} raw STX balance
        </button>
      )}
      {stxLinked && showRaw && (
        <pre className="json">{JSON.stringify(wallet?.stx.balance, null, 2)}</pre>
      )}
    </div>
  );
}
