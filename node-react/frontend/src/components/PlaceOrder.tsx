import { useEffect, useMemo, useState } from "react";
import { api, type PublicApp } from "../api";
import { fetchMarkets, type MarketSummary } from "../publicMarketData";
import { PoweredByStx } from "./PoweredByStx";

// The trade panel — the ISV's order-placement widget, styled like a real
// exchange ticket rather than a form. It posts to the backend proxy, which
// forwards to STX's `POST /api/v1/orders` with the member's bearer token.
//
// STX order body (mirrors the GraphQL `UserOrder` input): market_id, order_type
// ("limit"|"market"), action ("buy"|"sell"), price (cents string; limit only —
// STX rejects a price on a market order), quantity (decimal string).

function marketLabel(m: MarketSummary): string {
  const name = m.symbol || m.shortTitle || m.title || m.marketId;
  const event = m.eventShortTitle || m.eventTitle;
  return event && event !== name ? `${name} — ${event}` : name;
}

export function PlaceOrder({ app, onPlaced }: { app: PublicApp; onPlaced: () => void }) {
  const [marketId, setMarketId] = useState("");
  const [orderType, setOrderType] = useState<"limit" | "market">("limit");
  const [action, setAction] = useState<"buy" | "sell">("buy");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [batch, setBatch] = useState<Record<string, string>[]>([]);
  const [batchResult, setBatchResult] = useState<unknown>(null);

  const [markets, setMarkets] = useState<MarketSummary[]>([]);
  const [marketsLoading, setMarketsLoading] = useState(true);
  const [marketsError, setMarketsError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setMarketsLoading(true);
    fetchMarkets(200)
      .then((all) => {
        if (!live) return;
        setMarkets(all.filter((m) => m.status === "open"));
        setMarketsError(null);
      })
      .catch((e) => live && setMarketsError(String(e)))
      .finally(() => live && setMarketsLoading(false));
    return () => {
      live = false;
    };
  }, []);

  // Rough cost/return preview from the limit price (cents) and quantity. STX
  // settles a winning contract at $1.00, so max return ≈ quantity × $1.00.
  const estimate = useMemo(() => {
    const p = Number(price);
    const q = Number(quantity);
    if (!Number.isFinite(p) || !Number.isFinite(q) || q <= 0) return null;
    if (orderType === "limit" && (!Number.isFinite(p) || p <= 0)) return null;
    const cost = orderType === "limit" ? (p / 100) * q : null;
    const maxReturn = q * 1.0;
    return { cost, maxReturn };
  }, [price, quantity, orderType]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.placeOrder(buildOrder());
      setResult(res);
      onPlaced();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function buildOrder(): Record<string, string> {
    const order: Record<string, string> = {
      market_id: marketId,
      order_type: orderType,
      action,
      quantity,
    };
    // Market orders carry no price — STX rejects one. Limit only.
    if (orderType === "limit" && price.trim() !== "") order.price = price.trim();
    return order;
  }

  function addToBatch() {
    if (!marketId || quantity.trim() === "") return;
    if (orderType === "limit" && price.trim() === "") return;
    setBatch((b) => [...b, buildOrder()]);
    setBatchResult(null);
  }

  async function placeBatch() {
    if (batch.length === 0) return;
    setBusy(true);
    setError(null);
    setBatchResult(null);
    try {
      const res = await api.placeBatch(batch);
      setBatchResult(res);
      setBatch([]);
      onPlaced();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function marketName(id: string): string {
    const m = markets.find((x) => x.marketId === id);
    return m ? marketLabel(m) : id.slice(0, 8);
  }

  return (
    <div className="card trade-panel">
      <div className="trade-head">
        <h3>Trade</h3>
        <span className="trade-badge">on STX</span>
      </div>

      <form className="trade-form" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Market</span>
          <select value={marketId} onChange={(e) => setMarketId(e.target.value)} required>
            <option value="" disabled>
              {marketsLoading
                ? "Loading open markets…"
                : markets.length === 0
                  ? "No open markets available"
                  : "Select a market"}
            </option>
            {markets.map((m) => (
              <option key={m.marketId} value={m.marketId}>
                {marketLabel(m)}
              </option>
            ))}
          </select>
          {marketsError && <span className="error">Couldn’t load markets: {marketsError}</span>}
        </label>

        {/* Buy / Sell — the primary choice, as a segmented control. */}
        <div className="segmented" role="group" aria-label="Action">
          <button
            type="button"
            className={`seg seg-buy${action === "buy" ? " active" : ""}`}
            onClick={() => setAction("buy")}
          >
            Buy
          </button>
          <button
            type="button"
            className={`seg seg-sell${action === "sell" ? " active" : ""}`}
            onClick={() => setAction("sell")}
          >
            Sell
          </button>
        </div>

        <div className="trade-row">
          <label className="field">
            <span className="field-label">Order type</span>
            <select
              value={orderType}
              onChange={(e) => setOrderType(e.target.value as "limit" | "market")}
            >
              <option value="limit">Limit</option>
              <option value="market">Market</option>
            </select>
          </label>
          {orderType === "limit" && (
            <label className="field">
              <span className="field-label">Price (¢)</span>
              <input
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="e.g. 40"
                inputMode="numeric"
                required
              />
            </label>
          )}
          <label className="field">
            <span className="field-label">Quantity</span>
            <input
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="e.g. 100"
              inputMode="numeric"
              required
            />
          </label>
        </div>

        {estimate && (
          <div className="trade-estimate">
            {estimate.cost !== null && (
              <div className="est">
                <span>Est. cost</span>
                <strong>${estimate.cost.toFixed(2)}</strong>
              </div>
            )}
            <div className="est">
              <span>Max return</span>
              <strong>${estimate.maxReturn.toFixed(2)}</strong>
            </div>
          </div>
        )}

        <div className="trade-actions">
          <button
            className="trade-cta"
            type="submit"
            disabled={busy}
            style={{ background: action === "buy" ? "var(--accent)" : "var(--danger)" }}
          >
            {busy ? "Placing…" : `${action === "buy" ? "Buy" : "Sell"} on STX`}
          </button>
          <button type="button" className="link add-batch" onClick={addToBatch}>
            + Add to batch
          </button>
        </div>
      </form>

      {batch.length > 0 && (
        <div className="batch">
          <div className="batch-head">Batch ({batch.length})</div>
          <ul className="batch-list">
            {batch.map((o, i) => (
              <li key={i} className="batch-item">
                <span className={`badge badge-${o.action === "buy" ? "buy" : "sell"}`}>{o.action}</span>
                <span className="batch-terms">
                  {o.quantity}
                  {o.price ? ` @ ${o.price}¢` : ""} · {marketName(o.market_id)}
                </span>
                <button
                  type="button"
                  className="link danger"
                  onClick={() => setBatch((b) => b.filter((_, j) => j !== i))}
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="trade-cta batch-cta"
            disabled={busy}
            onClick={placeBatch}
            style={{ background: app.brandColor }}
          >
            {busy ? "Placing…" : `Place ${batch.length} orders on STX`}
          </button>
        </div>
      )}
      {batchResult != null && <p className="ok">Batch placed ✓</p>}

      {result != null && <p className="ok">Order placed ✓</p>}
      {error && <p className="error">{error}</p>}

      {/* Developer view: the exact JSON exchanged with STX, kept behind a toggle. */}
      {result != null && (
        <details className="trade-raw" open={showRaw} onToggle={(e) => setShowRaw((e.target as HTMLDetailsElement).open)}>
          <summary>raw STX response</summary>
          <pre className="json">{JSON.stringify(result, null, 2)}</pre>
        </details>
      )}

      <div className="trade-foot">
        <PoweredByStx compact />
      </div>
    </div>
  );
}
