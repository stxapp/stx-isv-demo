import { useEffect, useState } from "react";
import { dollars, type TradeMsg } from "../publicMarketData";
import { subscribeTrades } from "../marketFeed";

// Live tape of executed trades for one market, from STX's public `trades` topic
// relayed over the backend SSE proxy. The backend narrows to the one selected
// market. Each "trade" push is one execution; `action` is the taker's side
// ("buy" bought from the book, "sell" sold into it). This is a change feed:
// nothing arrives until the market trades. The most recent trade doubles as the
// "last price". Mount with a React `key={marketId}` for a clean resubscribe on switch.

const MAX_ROWS = 25;

interface Props {
  marketId: string;
}

export function TradesFeed({ marketId }: Props) {
  const [trades, setTrades] = useState<TradeMsg[]>([]);
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    setTrades([]);
    setJoined(false);

    const close = subscribeTrades(marketId, {
      onJoined: () => setJoined(true),
      onTrade: (t) => {
        if (t.market_id !== marketId) return;
        setTrades((prev) => [t, ...prev].slice(0, MAX_ROWS));
      },
    });

    return close;
  }, [marketId]);

  const last = trades[0];

  return (
    <div className="card">
      <h3>
        Recent trades
        {last && (
          <span className={`last-price last-${last.action}`}>
            {" "}
            last {dollars(last.price)}
          </span>
        )}
      </h3>
      {!joined ? (
        <p className="muted">Subscribing…</p>
      ) : trades.length === 0 ? (
        <p className="muted">No trades yet (arrives when the market trades).</p>
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
            {trades.map((t, i) => (
              <tr key={`${t.timestamp_us}-${i}`}>
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

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}
