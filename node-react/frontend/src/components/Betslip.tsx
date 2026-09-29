import { track } from "../analytics";
import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { formatMoney, teams, type MarketBrief, type MarketSummary } from "../publicMarketData";
import { EventStatus, MatchupInline, SportIcon } from "./EventBits";
import { LinkStxButton } from "./LinkStx";
import { PoweredByStx } from "./PoweredByStx";

// A betslip built by tapping market cards, placed as one batch through STX's
// `POST /api/v1/orders/batched`. Each leg is an independent order with its own
// side, price and quantity; "Place N" sends them together. The slip opens when
// the first market is tapped and closes when it is emptied. A member who has not
// linked STX yet sees the link call to action inside it, where the order would go.

export interface BetslipLeg {
  marketId: string;
  label: string;
  action: "buy" | "sell";
  orderType: "limit" | "market";
  price: string; // cents; ignored for market orders
  quantity: string;
  maxPrice?: number | null; // settlement ceiling in cents (100 = $1 market)
  // The market as the catalog described it: sport, teams, event status, question.
  market?: MarketSummary;
}

const fmt = (n: number) => formatMoney(n);

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
  appName,
  briefs,
  checkingLink = false,
  onUnlinked,
}: {
  legs: BetslipLeg[];
  onChange: (legs: BetslipLeg[]) => void;
  onPlaced: () => void;
  linked: boolean;
  signedIn: boolean;
  appName: string;
  // Live event status (score, clock) by event id.
  briefs: Record<string, MarketBrief>;
  // The app is re-checking the STX link: Place waits for the answer.
  checkingLink?: boolean;
  // An order came back "not linked": the app re-reads the link.
  onUnlinked?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<number | null>(null);

  // The confirmation stands in for the emptied slip for a few seconds.
  useEffect(() => {
    if (placed == null || legs.length > 0) return;
    const t = setTimeout(() => setPlaced(null), 5000);
    return () => clearTimeout(t);
  }, [placed, legs.length]);

  // No slip until a market is tapped: the home page is for browsing.
  if (legs.length === 0 && placed == null) return null;
  if (legs.length === 0) {
    return (
      <div className="card betslip-panel betslip-done" id="betslip">
        <p className="ok">
          Placed {placed} order{placed === 1 ? "" : "s"} on STX ✓
        </p>
        <button type="button" className="link" onClick={() => setPlaced(null)}>
          Close
        </button>
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
    // Price is whole cents within the market's range; say so here rather than
    // relaying STX's API-shaped rejection ("must be a dollar string").
    for (const l of legs) {
      const q = Number(l.quantity);
      if (!Number.isInteger(q) || q <= 0) {
        setError(`${l.label}: quantity must be a whole number of contracts.`);
        setBusy(false);
        return;
      }
      if (l.orderType === "limit") {
        const p = Number(l.price);
        if (!Number.isInteger(p) || p < 1 || p > maxCents(l)) {
          setError(`${l.label}: price is in cents, a whole number from 1 to ${maxCents(l)}.`);
          setBusy(false);
          return;
        }
      }
    }
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
      track("order_place", { count: legs.length });
      setPlaced(legs.length);
      onChange([]);
      onPlaced();
    } catch (e) {
      // ApiError.message already carries STX's own rejection (e.g. "price must
      // be between 1 and 99", "market closed") on a 422, or the not-connected
      // message on a 401.
      if (e instanceof ApiError && e.notLinked) {
        // The link died since the slip opened: the slip turns into the link
        // call to action once the app has re-read it.
        onUnlinked?.();
      } else {
        setError(e instanceof ApiError ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card betslip-panel" id="betslip">
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
            {/* Row 1: sport, "AWAY @ HOME", start time or live clock, remove. */}
            <div className="leg-event">
              {l.market && <SportIcon sport={l.market.sport} size={12} />}
              {/* The league shows only when there is no matchup to show. */}
              {l.market && (
                <span className={`leg-competition${teams(l.market).length >= 2 ? " visually-hidden" : ""}`}>
                  {l.market.competition ?? l.market.sport}
                </span>
              )}
              {l.market && <MatchupInline market={l.market} brief={l.market.eventId ? briefs[l.market.eventId] : undefined} />}
              {l.market && <EventStatus market={l.market} brief={l.market.eventId ? briefs[l.market.eventId] : undefined} />}
              <button
                type="button"
                className="leg-remove"
                onClick={() => remove(i)}
                aria-label={`Remove ${l.label} from betslip`}
              >
                ×
              </button>
            </div>
            {/* Row 2: side, selection (the market question as its tooltip), contract
                size, and the order's cost and payout (or what it still needs). */}
            <div className="leg-top">
              <span className={`leg-side leg-side-${l.action}`}>{l.action}</span>
              <span className="leg-label" title={l.market?.question ? `${l.label}: ${l.market.question}` : l.label}>
                {l.label}
                {l.market?.question && <span className="visually-hidden">. {l.market.question}</span>}
              </span>
              <span
                className="leg-scale"
                title={`$${(maxCents(l) / 100).toFixed(2)} market: contracts settle at ${maxCents(l)}¢`}
              >
                ${maxCents(l) / 100}
              </span>
              {econ ? (
                <span className="leg-math">
                  <span className="visually-hidden">{l.action === "buy" ? "Cost" : "You get"} </span>
                  <b title={l.action === "buy" ? "Cost" : "You get"}>{fmt(econ.cost)}</b>
                  <span className="leg-math-arrow" aria-hidden="true">→</span>
                  <span className="visually-hidden">, {l.action === "buy" ? "to win" : "you risk"} </span>
                  <b className={l.action === "buy" ? "pos" : "neg"} title={l.action === "buy" ? "To win" : "You risk"}>
                    {fmt(econ.win)}
                  </b>
                </span>
              ) : (
                <span className="leg-math leg-math-hint">
                  {l.orderType === "market" ? "At market" : "Price & qty"}
                </span>
              )}
            </div>
            {/* Row 3: the order controls, one compact row. */}
            <div className="leg-controls">
              <div className="segmented seg-sm" role="group" aria-label="Side">
                <button
                  type="button"
                  className={`seg seg-buy${l.action === "buy" ? " active" : ""}`}
                  aria-pressed={l.action === "buy"}
                  onClick={() => patch(i, { action: "buy" })}
                >
                  Buy
                </button>
                <button
                  type="button"
                  className={`seg seg-sell${l.action === "sell" ? " active" : ""}`}
                  aria-pressed={l.action === "sell"}
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
                title={l.orderType === "market" ? "Market: fills at the market price" : "Limit: fills at your price or better"}
              >
                <option value="limit">Limit</option>
                <option value="market">Market</option>
              </select>
              {l.orderType === "limit" && (
                <input
                  className="leg-input"
                  inputMode="numeric"
                  placeholder={`1–${maxCents(l)}¢`}
                  aria-label={`Price in cents, 1 to ${maxCents(l)}`}
                  title={`Price in cents, 1 to ${maxCents(l)} ($${(maxCents(l) / 100).toFixed(2)} market)`}
                  value={l.price}
                  onChange={(e) => patch(i, { price: e.target.value.replace(/\D/g, "") })}
                />
              )}
              <input
                className="leg-input"
                inputMode="numeric"
                placeholder="qty"
                aria-label="Quantity (contracts)"
                value={l.quantity}
                onChange={(e) => patch(i, { quantity: e.target.value.replace(/\D/g, "") })}
              />
            </div>
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
          disabled={!ready || busy || checkingLink}
          onClick={placeAll}
        >
          {busy
            ? "Placing…"
            : checkingLink
              ? "Checking your STX link…"
              : `Place ${legs.length} order${legs.length > 1 ? "s" : ""} on STX`}
        </button>
      ) : (
        // Not linked (never, or the link died): the link call to action takes
        // the Place button's spot, so nothing can be placed until STX is linked.
        // Signed out, the link starts with a demo {appName} account.
        <div className="betslip-linkbox" id="betslip-link">
          <p className="betslip-linkbox-lead">
            Orders go to the STX Exchange. Link your STX account to place{" "}
            {legs.length > 1 ? `these ${legs.length} orders` : "this order"}
            {signedIn ? "." : `; a demo ${appName} account is created for you.`}
          </p>
          <LinkStxButton appName={appName} hint={false} block />
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <div className="betslip-foot">
        <PoweredByStx compact />
      </div>
    </div>
  );
}
