import { useEffect, useState } from "react";
import { Socket, type Channel } from "phoenix";
import { dollars, type BookLevel, type BookSnapshot } from "../publicMarketData";

// Live aggregated order book for one market, from STX's public `orderbook` topic.
//
// Join carries a `market_ids` filter (a non-empty list is REQUIRED by the server;
// an empty/absent list is an error, not "all markets"). Each "book" push is a
// COMPLETE snapshot for that market_id — we replace the book wholesale, never
// apply deltas. Mount this with a React `key={marketId}` so a market switch
// remounts and rejoins cleanly.

interface Props {
  socket: Socket | null;
  marketId: string;
}

export function OrderBook({ socket, marketId }: Props) {
  const [book, setBook] = useState<BookSnapshot | null>(null);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!socket) return;
    setBook(null);
    setJoined(false);
    setError(null);

    const channel: Channel = socket.channel("orderbook", { market_ids: [marketId] });

    channel.on("book", (payload: BookSnapshot) => {
      // Only the selected market is subscribed, but guard anyway.
      if (payload.market_id === marketId) setBook(payload);
    });

    channel
      .join()
      .receive("ok", () => setJoined(true))
      .receive("error", (resp: { reason?: string }) =>
        setError(resp?.reason ?? "join failed"),
      );

    return () => {
      channel.leave();
    };
  }, [socket, marketId]);

  const bids = book?.bids ?? [];
  const offers = book?.offers ?? [];
  // Offers render best (lowest) at the bottom, nearest the spread, like a book.
  const offersTopDown = [...offers].reverse();

  return (
    <div className="card">
      <h3>Order book</h3>
      {error ? (
        <p className="error">Book unavailable: {error}</p>
      ) : !joined ? (
        <p className="muted">Subscribing…</p>
      ) : bids.length === 0 && offers.length === 0 ? (
        <p className="muted">No resting orders yet.</p>
      ) : (
        <div className="book">
          <BookSide levels={offersTopDown} side="offer" />
          <div className="book-spread">
            <span>bid</span>
            <span>offer</span>
          </div>
          <BookSide levels={bids} side="bid" />
        </div>
      )}
    </div>
  );
}

function BookSide({ levels, side }: { levels: BookLevel[]; side: "bid" | "offer" }) {
  return (
    <table className={`book-side book-${side}`}>
      <tbody>
        {levels.map((lvl, i) => (
          <tr key={`${lvl.price}-${i}`}>
            <td className="book-price">{dollars(lvl.price)}</td>
            <td className="book-qty">{lvl.quantity}</td>
            <td className="book-liq">{dollars(lvl.total_liquidity)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
