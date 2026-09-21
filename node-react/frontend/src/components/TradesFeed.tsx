import { useEffect, useState } from "react";
import { Socket, type Channel } from "phoenix";
import { dollars, type TradeMsg } from "../publicMarketData";

// Live tape of executed trades for one market, from STX's public `trades` topic.
//
// Join carries optional `market_ids` / `event_ids` filters; we narrow to the one
// selected market. Each "trade" push is one execution; `action` is the taker's
// side ("buy" bought from the book, "sell" sold into it). This is a change feed —
// nothing arrives until the market trades. The most recent trade doubles as the
// "last price". Mount with a React `key={marketId}` for a clean rejoin on switch.

const MAX_ROWS = 25;

interface Props {
  socket: Socket | null;
  marketId: string;
}

export function TradesFeed({ socket, marketId }: Props) {
  const [trades, setTrades] = useState<TradeMsg[]>([]);
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    if (!socket) return;
    setTrades([]);
    setJoined(false);

    const channel: Channel = socket.channel("trades", { market_ids: [marketId] });

    channel.on("trade", (t: TradeMsg) => {
      if (t.market_id !== marketId) return;
      setTrades((prev) => [t, ...prev].slice(0, MAX_ROWS));
    });

    channel
      .join()
      .receive("ok", () => setJoined(true))
      .receive("error", () => setJoined(false));

    return () => {
      channel.leave();
    };
  }, [socket, marketId]);

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
