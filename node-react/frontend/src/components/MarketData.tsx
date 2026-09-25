import { useEffect, useMemo, useState } from "react";
import {
  dollars,
  fetchMarkets,
  isLive,
  type MarketBrief,
  type MarketSummary,
  type TickerUpdate,
} from "../publicMarketData";
import { subscribeBriefs, subscribeTicker, type FeedStatus } from "../marketFeed";
import { MarketBrowser } from "./MarketBrowser";
import { OrderBook } from "./OrderBook";
import { TradesFeed } from "./TradesFeed";

// Public market-data browsing. The browser talks only to the ISV backend now:
// the catalog over GET /api/markets, the live feeds over the backend's SSE proxy
// (GET /api/market-stream). The backend attributes both to the app with an app
// token; nothing here goes to STX directly.
//
// This container owns:
//   - the market catalog (fetched once via GET /api/markets);
//   - the market-wide `ticker` change feed, subscribed unfiltered so last prices
//     overlay the whole list; and
//   - the currently selected market.
//
//   - the live scores: one `market:<id>` join per live event (and per betslip
//     market), relayed by the backend as `brief` events and handed up through
//     `onBrief` so the betslip shows them too.
//
// The order book and trades detail subscribe per-market (keyed by market_id) so
// switching markets remounts them into a clean resubscribe.

// The backend joins at most this many markets for live scores.
const MAX_BRIEFS = 12;

// A game about to start is watched too, so the page turns live at first pitch
// without a reload.
const STARTING_SOON_MS = 15 * 60_000;

function watched(m: MarketSummary, now: number): boolean {
  if (isLive(m.eventStatus)) return true;
  return m.eventStatus === "scheduled" && m.eventStart != null && m.eventStart - now < STARTING_SOON_MS;
}

// One market per live (or about to start) event to read its score from, live
// games first: the plain game market (no stat-line prop) with the shortest
// title, else the first.
function liveEventMarkets(markets: MarketSummary[], now = Date.now()): string[] {
  const byEvent = new Map<string, MarketSummary>();
  for (const m of markets) {
    if (!m.eventId || !watched(m, now)) continue;
    const cur = byEvent.get(m.eventId);
    const better =
      !cur ||
      (cur.statDetail && !m.statDetail) ||
      (!cur.statDetail === !m.statDetail && (m.title?.length ?? 999) < (cur.title?.length ?? 999));
    if (better) byEvent.set(m.eventId, m);
  }
  return [...byEvent.values()]
    .sort((x, y) => Number(!isLive(x.eventStatus)) - Number(!isLive(y.eventStatus)))
    .map((m) => m.marketId);
}

export function MarketData({
  betslipIds,
  onToggleBetslip,
  briefs,
  onBrief,
  homeKey,
}: {
  betslipIds: Set<string>;
  onToggleBetslip: (m: MarketSummary) => void;
  // Live event status by event id (see subscribeBriefs).
  briefs: Record<string, MarketBrief>;
  onBrief: (eventId: string, b: MarketBrief) => void;
  // Bumped by the logo link: back to all events, no open game or book.
  homeKey: number;
}) {
  const [status, setStatus] = useState<FeedStatus>("connecting");

  const [markets, setMarkets] = useState<MarketSummary[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [tickers, setTickers] = useState<Record<string, TickerUpdate>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // --- Catalog (backend proxy) ---
  useEffect(() => {
    let cancelled = false;
    fetchMarkets(500)
      .then((all) => {
        if (cancelled) return;
        // Only open markets are tradeable and have a live book: hide resulted
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

  // --- Market-wide ticker feed (backend SSE proxy) ---
  useEffect(() => {
    const close = subscribeTicker(
      (payload) => setTickers((prev) => ({ ...prev, [payload.market_id]: payload })),
      setStatus,
    );
    return close;
  }, []);

  useEffect(() => setSelectedId(null), [homeKey]);

  // --- Live scores (backend SSE proxy over market:<id>) ---
  // Betslip markets first (the member is looking at them), then live events.
  const briefIds = useMemo(() => {
    const ids = [...betslipIds, ...liveEventMarkets(markets)];
    return [...new Set(ids)].slice(0, MAX_BRIEFS);
  }, [markets, betslipIds]);
  const briefKey = briefIds.join(",");
  const eventOf = useMemo(() => new Map(markets.map((m) => [m.marketId, m.eventId])), [markets]);
  useEffect(() => {
    if (!briefKey) return;
    return subscribeBriefs(briefKey.split(","), (b) => {
      const eventId = b.event_id ?? eventOf.get(b.market_id);
      if (eventId) onBrief(eventId, b);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [briefKey]);

  const selectedMarket = useMemo(
    () => markets.find((m) => m.marketId === selectedId) ?? null,
    [markets, selectedId],
  );
  const selectedTicker = selectedId ? tickers[selectedId] : undefined;

  return (
    <>
      <p className="muted market-intro">
        Live markets, prices and scores from the STX Exchange.
        <span className={`ws ws-${status}`} title={`connection: ${status}`}>
          {status === "open" ? "● live" : "○ connecting"}
        </span>
      </p>

      <MarketBrowser
        markets={markets}
        tickers={tickers}
        briefs={briefs}
        homeKey={homeKey}
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
            {/* key forces a clean resubscribe when the market changes */}
            <OrderBook key={`ob-${selectedId}`} marketId={selectedId!} />
            <TradesFeed key={`tr-${selectedId}`} marketId={selectedId!} />
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
      <Stat label="Open int." value={ticker.open_interest ?? "-"} />
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
