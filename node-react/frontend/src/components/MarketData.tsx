import { useEffect, useMemo, useRef, useState } from "react";
import { Socket, type Channel } from "phoenix";
import {
  dollars,
  fetchMarkets,
  STX_WS_URL,
  type MarketSummary,
  type TickerUpdate,
} from "../publicMarketData";
import { MarketBrowser } from "./MarketBrowser";
import { OrderBook } from "./OrderBook";
import { TradesFeed } from "./TradesFeed";

// Public market-data browsing — no credential of any kind. The browser talks to
// STX directly: the catalog over public GraphQL, the live feeds over public
// Phoenix channels. Nothing here goes through the ISV backend proxy.
//
// This container owns:
//   - the single WebSocket to STX (shared by every child channel);
//   - the market catalog (fetched once via `marketInfos`);
//   - the market-wide `ticker` change feed, joined unfiltered so last prices
//     overlay the whole list; and
//   - the currently selected market.
//
// The order book and trades detail subscribe per-market (keyed by market_id) so
// switching markets remounts them into a clean rejoin.

type WsStatus = "connecting" | "open" | "error" | "closed";

export function MarketData({
  betslipIds,
  onToggleBetslip,
}: {
  betslipIds: Set<string>;
  onToggleBetslip: (m: MarketSummary) => void;
}) {
  const [status, setStatus] = useState<WsStatus>("connecting");
  const [socket, setSocket] = useState<Socket | null>(null);

  const [markets, setMarkets] = useState<MarketSummary[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [tickers, setTickers] = useState<Record<string, TickerUpdate>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const tickerChannelRef = useRef<Channel | null>(null);

  // --- Catalog (public GraphQL) ---
  useEffect(() => {
    let cancelled = false;
    fetchMarkets(500)
      .then((all) => {
        if (cancelled) return;
        // Only open markets are tradeable and have a live book — hide resulted
        // and suspended ones from the browse list.
        const list = all.filter((m) => m.status === "open");
        setMarkets(list);
        // Do NOT auto-select a market: selectedId only opens the order-book modal
        // when a card's book icon is clicked, so nothing pops open on load.
      })
      .catch((e: unknown) => {
        if (!cancelled) setCatalogError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Socket + market-wide ticker feed (public channels) ---
  useEffect(() => {
    const sock = new Socket(`${STX_WS_URL}/socket`, {});
    sock.onOpen(() => setStatus("open"));
    sock.onError(() => setStatus("error"));
    sock.onClose(() => setStatus("closed"));
    sock.connect();
    setSocket(sock);

    const channel = sock.channel("ticker", {});
    channel.on("ticker", (payload: TickerUpdate) => {
      setTickers((prev) => ({ ...prev, [payload.market_id]: payload }));
    });
    channel.join();
    tickerChannelRef.current = channel;

    return () => {
      channel.leave();
      sock.disconnect();
      tickerChannelRef.current = null;
      setSocket(null);
    };
  }, []);

  const selectedMarket = useMemo(
    () => markets.find((m) => m.marketId === selectedId) ?? null,
    [markets, selectedId],
  );
  const selectedTicker = selectedId ? tickers[selectedId] : undefined;

  return (
    <>
      <p className="muted market-intro">
        Live STX markets and order book.
        <span className={`ws ws-${status}`} title={`connection: ${status}`}>
          {status === "open" ? "● live" : "○ connecting"}
        </span>
      </p>

      <MarketBrowser
        markets={markets}
        tickers={tickers}
        socket={socket}
        betslipIds={betslipIds}
        onToggle={onToggleBetslip}
        onOpenBook={setSelectedId}
        loading={catalogLoading}
        error={catalogError}
      />

      {/* Order-book modal, opened from a card's book icon. */}
      {selectedMarket && (
        <div className="book-modal-backdrop" onClick={() => setSelectedId(null)}>
          <div className="book-modal" onClick={(e) => e.stopPropagation()}>
            <div className="book-modal-head">
              <div>
                <h3>{selectedMarket.title ?? selectedMarket.symbol ?? "Market"}</h3>
                <TickerSummary ticker={selectedTicker} />
              </div>
              <button
                type="button"
                className="book-modal-close"
                onClick={() => setSelectedId(null)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            {/* key forces a clean channel rejoin when the market changes */}
            <OrderBook key={`ob-${selectedId}`} socket={socket} marketId={selectedId!} />
            <TradesFeed key={`tr-${selectedId}`} socket={socket} marketId={selectedId!} />
          </div>
        </div>
      )}
    </>
  );
}

// Live one-line summary for the selected market, from the `ticker` change feed.
// Empty until the market next moves (the ticker pushes nothing on join).
function TickerSummary({ ticker }: { ticker: TickerUpdate | undefined }) {
  if (!ticker) return null;
  return (
    <div className="ticker-summary">
      <Stat label="Last" value={dollars(ticker.last_traded_price)} />
      <Stat label="Bid" value={dollars(ticker.best_bid)} />
      <Stat label="Offer" value={dollars(ticker.best_offer)} />
      <Stat label="Volume" value={dollars(ticker.total_volume)} />
      <Stat label="Open int." value={ticker.open_interest ?? "—"} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}
