import { useEffect, useState } from "react";
import { dollars, fetchRecentTrades, type TradeMsg } from "../publicMarketData";
import { subscribeTrades } from "../marketFeed";

// Tape of executed trades for one market. Two sources, merged:
//   - the market's recent trades (the last 15) from the backend's REST call
//     (GET /api/markets/:id/trades), so the tape is filled on open; and
//   - STX's public `trades` topic relayed over the backend SSE proxy, narrowed
//     to this market. It is a change feed: its join carries no history and it
//     pushes only executions made after the join, so on its own the tape stays
//     empty until the market next trades.
// Each row is one execution; `action` is the taker's side ("buy" bought from
// the book, "sell" sold into it). The newest trade doubles as the "last price".
// `useMarketTrades` holds the data; `TradesFeed` renders the tape.

const MAX_ROWS = 25;

// A trade's identity across the two sources (same execution, same fields).
function tradeKey(t: TradeMsg): string {
  return `${t.timestamp_us}|${t.price}|${t.quantity}`;
}

// Newest first, one row per execution, capped.
function merge(a: TradeMsg[], b: TradeMsg[]): TradeMsg[] {
  const seen = new Map<string, TradeMsg>();
  for (const t of [...a, ...b]) if (!seen.has(tradeKey(t))) seen.set(tradeKey(t), t);
  return [...seen.values()].sort((x, y) => y.timestamp_us - x.timestamp_us).slice(0, MAX_ROWS);
}

// The market's trades, newest first: seeded from REST, kept live by the feed.
// `loading` is true until either source has answered. One call per market;
// the tape and the price chart share it.
export function useMarketTrades(marketId: string): { trades: TradeMsg[]; loading: boolean } {
  const [trades, setTrades] = useState<TradeMsg[]>([]);
  const [seeded, setSeeded] = useState(false);
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTrades([]);
    setSeeded(false);
    setJoined(false);

    fetchRecentTrades(marketId)
      .then((recent) => {
        if (!cancelled) setTrades((prev) => merge(prev, recent.filter((t) => t.market_id === marketId)));
      })
      .catch(() => {
        // The live feed still fills the tape; the empty state says so.
      })
      .finally(() => {
        if (!cancelled) setSeeded(true);
      });

    const close = subscribeTrades(marketId, {
      onJoined: () => setJoined(true),
      onTrade: (t) => {
        if (t.market_id !== marketId) return;
        setTrades((prev) => merge([t], prev));
      },
    });

    return () => {
      cancelled = true;
      close();
    };
  }, [marketId]);

  return { trades, loading: !seeded && !joined && trades.length === 0 };
}

export function TradesFeed({ trades, loading }: { trades: TradeMsg[]; loading: boolean }) {
  const last = trades[0];

  return (
    <div className="card">
      <div className="card-title-row">
        <h3>Recent trades</h3>
        {last && <span className={`last-price last-${last.action}`}>Last {dollars(last.price)}</span>}
      </div>
      {loading ? (
        <p className="muted">Loading…</p>
      ) : trades.length === 0 ? (
        <p className="muted">No trades on this market yet. New trades appear here as they happen.</p>
      ) : (
        <table className="ticker">
          <thead>
            <tr>
              <th>Time</th>
              <th>Side</th>
              <th>Price</th>
              <th>Qty</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr key={tradeKey(t)}>
                <td className="note">{formatTime(t.timestamp)}</td>
                <td className={`trade-${t.action}`}>{t.action}</td>
                <td>{dollars(t.price)}</td>
                <td>{t.quantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// Time of day for today's trades, with the date for older ones.
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}
