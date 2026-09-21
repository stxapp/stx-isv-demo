import { useState } from "react";
import { api, ApiError, startLink } from "../api";
import { PoweredByStx } from "./PoweredByStx";

// A betslip built by multi-selecting market cards, placed as one batch through
// STX's confirmOrders (GraphQL). Each leg is an independent limit order with its
// own side, price and quantity; "Place N" sends them together.

export interface BetslipLeg {
  marketId: string;
  label: string;
  action: "buy" | "sell";
  orderType: "limit" | "market";
  price: string; // cents; ignored for market orders
  quantity: string;
  maxPrice?: number | null; // settlement ceiling in cents (100 = $1 market)
}

const fmt = (n: number) => `$${n.toFixed(2)}`;

// A market's settlement ceiling in cents (default $1 / 100¢ when unknown).
function maxCents(l: BetslipLeg): number {
  return l.maxPrice && l.maxPrice > 0 ? l.maxPrice : 100;
}

// The money a leg commits and stands to make. A contract settles at the market's
// max price, so at price P¢ for Q contracts: a buy pays Q·P/100 now and wins
// Q·(max−P)/100 if it resolves yes; a sell is the mirror. Null until both price
// and quantity are known (a market order has no price yet).
function legEconomics(l: BetslipLeg): { cost: number; win: number } | null {
  const q = parseFloat(l.quantity);
  const p = parseFloat(l.price);
  const max = maxCents(l);
  if (!Number.isFinite(q) || q <= 0) return null;
  if (l.orderType === "market" || !Number.isFinite(p) || p <= 0) return null;
  return { cost: (q * p) / 100, win: (q * (max - p)) / 100 };
}

export function Betslip({
  legs,
  onChange,
  onPlaced,
  linked,
  signedIn,
}: {
  legs: BetslipLeg[];
  onChange: (legs: BetslipLeg[]) => void;
  onPlaced: () => void;
  linked: boolean;
  signedIn: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<number | null>(null);

  // Always visible so it is a stable place-orders panel: empty until markets are
  // added from the grid.
  if (legs.length === 0) {
    return (
      <div className="card betslip-panel betslip-empty">
        <div className="betslip-head">
          <h3>Betslip</h3>
          <span className="betslip-count betslip-count-zero">0</span>
        </div>
        <p className="muted">
          Tap markets in the grid to add them here, then place them together as one slip.
        </p>
        <div className="betslip-foot">
          <PoweredByStx compact />
        </div>
      </div>
    );
  }

  function patch(i: number, p: Partial<BetslipLeg>) {
    onChange(legs.map((l, j) => (j === i ? { ...l, ...p } : l)));
    setPlaced(null);
  }
  function remove(i: number) {
    onChange(legs.filter((_, j) => j !== i));
  }

  const ready =
    linked &&
    legs.every(
      (l) => l.quantity.trim() !== "" && (l.orderType === "market" || l.price.trim() !== ""),
    );

  // Live slip totals across the priced legs, updated as prices/quantities change.
  const totals = legs.reduce(
    (acc, l) => {
      const e = legEconomics(l);
      if (e) {
        acc.cost += e.cost;
        acc.win += e.win;
        acc.priced += 1;
      }
      return acc;
    },
    { cost: 0, win: 0, priced: 0 },
  );

  async function placeAll() {
    setBusy(true);
    setError(null);
    setPlaced(null);
    try {
      const orders = legs.map((l) => {
        const o: Record<string, string> = {
          market_id: l.marketId,
          order_type: l.orderType,
          action: l.action,
          quantity: l.quantity.trim(),
        };
        // Market orders carry no price; STX rejects one.
        if (l.orderType === "limit") o.price = l.price.trim();
        return o;
      });
      await api.placeBatch(orders);
      setPlaced(legs.length);
      onChange([]);
      onPlaced();
    } catch (e) {
      // ApiError.message already carries STX's own rejection (e.g. "price must
      // be between 1 and 99", "market closed") on a 422, or the not-connected
      // message on a 401.
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card betslip-panel">
      <div className="betslip-head">
        <h3>Betslip</h3>
        <span className="betslip-count">{legs.length}</span>
        <button type="button" className="link betslip-clear" onClick={() => onChange([])}>
          Clear
        </button>
      </div>

      <ul className="betslip-legs">
        {legs.map((l, i) => {
          const econ = legEconomics(l);
          return (
          <li key={l.marketId} className={`betslip-leg leg-${l.action}`}>
            <div className="leg-top">
              <span className={`leg-side leg-side-${l.action}`}>{l.action}</span>
              <span className="leg-label" title={l.label}>{l.label}</span>
              <span
                className="leg-scale"
                title={`$${(maxCents(l) / 100).toFixed(2)} market — contracts settle at ${maxCents(l)}¢`}
              >
                ${maxCents(l) / 100}
              </span>
              <button
                type="button"
                className="leg-remove"
                onClick={() => remove(i)}
                aria-label="Remove from betslip"
              >
                ×
              </button>
            </div>
            <div className="leg-controls">
              <div className="segmented seg-sm" role="group" aria-label="Side">
                <button
                  type="button"
                  className={`seg seg-buy${l.action === "buy" ? " active" : ""}`}
                  onClick={() => patch(i, { action: "buy" })}
                >
                  Buy
                </button>
                <button
                  type="button"
                  className={`seg seg-sell${l.action === "sell" ? " active" : ""}`}
                  onClick={() => patch(i, { action: "sell" })}
                >
                  Sell
                </button>
              </div>
              <select
                className="leg-select"
                value={l.orderType}
                onChange={(e) => patch(i, { orderType: e.target.value as "limit" | "market" })}
                aria-label="Order type"
              >
                <option value="limit">Limit</option>
                <option value="market">Market</option>
              </select>
              {l.orderType === "limit" && (
                <input
                  className="leg-input"
                  inputMode="numeric"
                  placeholder={`1–${maxCents(l)}¢`}
                  title={`Price in cents, 1 to ${maxCents(l)} ($${(maxCents(l) / 100).toFixed(2)} market)`}
                  value={l.price}
                  onChange={(e) => patch(i, { price: e.target.value })}
                />
              )}
              <input
                className="leg-input"
                inputMode="numeric"
                placeholder="qty"
                value={l.quantity}
                onChange={(e) => patch(i, { quantity: e.target.value })}
              />
            </div>
            {econ ? (
              <div className="leg-math">
                <span className="leg-math-item">
                  <span className="leg-math-k">{l.action === "buy" ? "Cost" : "You get"}</span>
                  <b>{fmt(econ.cost)}</b>
                </span>
                <span className="leg-math-arrow" aria-hidden="true">→</span>
                <span className="leg-math-item">
                  <span className="leg-math-k">{l.action === "buy" ? "To win" : "You risk"}</span>
                  <b className={l.action === "buy" ? "pos" : "neg"}>{fmt(econ.win)}</b>
                </span>
              </div>
            ) : (
              <div className="leg-math leg-math-hint">
                {l.orderType === "market" ? "Fills at the market price" : "Enter price & quantity"}
              </div>
            )}
          </li>
          );
        })}
      </ul>

      {totals.priced > 0 && (
        <div className="betslip-summary">
          <div className="sum-row">
            <span className="sum-k">Total cost</span>
            <b className="sum-v">{fmt(totals.cost)}</b>
          </div>
          <div className="sum-row">
            <span className="sum-k">Total to win</span>
            <b className="sum-v pos">{fmt(totals.win)}</b>
          </div>
        </div>
      )}

      {linked ? (
        <button
          type="button"
          className="trade-cta betslip-place"
          disabled={!ready || busy}
          onClick={placeAll}
        >
          {busy ? "Placing…" : `Place ${legs.length} order${legs.length > 1 ? "s" : ""} on STX`}
        </button>
      ) : signedIn ? (
        <>
          <div className="betslip-notice">
            <span className="notice-icon" aria-hidden="true">⚠</span>
            <span>
              Log in to STX and link your account to place {legs.length} order
              {legs.length > 1 ? "s" : ""}.
            </span>
          </div>
          <button type="button" className="trade-cta betslip-link" onClick={startLink}>
            Link your STX account
          </button>
        </>
      ) : (
        <div className="betslip-notice">
          <span className="notice-icon" aria-hidden="true">⚠</span>
          <span>Sign in above, then link your STX account to place these.</span>
        </div>
      )}
      {placed != null && <p className="ok">Placed {placed} ✓</p>}
      {error && <p className="error">{error}</p>}
      <div className="betslip-foot">
        <PoweredByStx compact />
      </div>
    </div>
  );
}
