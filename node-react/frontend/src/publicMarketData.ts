// STX market data — served entirely through the ISV backend now.
//
// The browser no longer talks to STX for market data. Both surfaces go through
// the confidential backend, which attributes them to the app with an app token
// (client_credentials, scope `market_data`) that never reaches the browser:
//
//   1. Catalog: GET ${BACKEND}/api/markets (see `fetchMarkets` below). The
//      backend fetches STX's REST `/api/v1/markets` and reshapes it into this
//      module's `MarketSummary` shape. Money fields are INTEGER SUBUNITS
//      (cents); `price` is a float.
//
//   2. Live feeds: Server-Sent Events from ${BACKEND}/api/market-stream (see
//      marketFeed.ts), relaying STX's public `ticker`, `trades`, `orderbook` and
//      `market_stats` channels. Their payloads use the "dollar wire format":
//      money and quantities are STRINGS already formatted in dollars, so they
//      render as-is (do NOT divide by 100).
//
// The catalog seeds the list; the SSE feeds keep it live. `STX_HTTP_URL` stays
// only for links that open the STX site itself (deposit, "powered by") — not for
// market data.

import { BACKEND, getActiveApp } from "./api";

export const STX_HTTP_URL =
  import.meta.env.VITE_STX_HTTP_URL ?? "http://localhost:4000";

// ---- Catalog --------------------------------------------------------------

// One market as returned by the backend catalog (GET /api/markets). Money fields
// are integer subunits (cents); `price` is a float in [0,1].
export interface MarketSummary {
  marketId: string;
  symbol: string | null;
  title: string | null;
  shortTitle: string | null;
  eventId: string | null;
  eventTitle: string | null;
  eventShortTitle: string | null;
  sport: string | null;
  competition: string | null;
  status: string | null;
  price: number | null;
  // The market's settlement ceiling in cents: 100 = a $1 market, 10000 = a $100
  // market. Prices are entered 1..maxPrice.
  maxPrice: number | null;
  lastTradedPrice: number | null; // cents
  volume24h: number | null; // cents
  // The pipe-delimited settlement specifier (player|jersey|STAT|line for a
  // player prop, side|EVENT_STAT|NA for a game prop). Null for a plain market.
  specifier: string | null;
  // Non-null when the market is a stat-line prop. `player` set => player prop;
  // set with no `player` => event/game prop.
  statDetail: {
    propType: string | null;
    player: string | null;
    stat: string | null;
    statDisplayName: string | null;
    line: number | null;
  } | null;
}

// Fetches the market catalog from the backend. `limit` bounds the list. The
// backend narrows to OPEN markets and reshapes STX's REST response into
// `MarketSummary`. Sends the session cookie + active app (same as every /api
// call) so the read is attributed to the right app profile. Throws with a
// readable message on transport errors so the caller can surface them.
export async function fetchMarkets(limit = 500): Promise<MarketSummary[]> {
  const res = await fetch(`${BACKEND}/api/markets?app=${encodeURIComponent(getActiveApp())}&limit=${limit}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(`Market catalog responded ${res.status}`);
  }

  const body = (await res.json()) as { markets?: MarketSummary[] };
  return body.markets ?? [];
}

// ---- Live channel payloads (dollar wire format) ---------------------------

// One aggregated price level on the `orderbook` topic's "book" push. Every value
// is a pre-formatted dollar/quantity string. Levels are best-first; the `total_*`
// fields are cumulative through that level.
export interface BookLevel {
  price: string;
  quantity: string;
  liquidity: string;
  total_quantity: string;
  total_liquidity: string;
}

// A full snapshot of one market's book. NOT a delta — replace wholesale on each
// push (the server documents every "book" push as a complete snapshot).
export interface BookSnapshot {
  market_id: string;
  bids: BookLevel[];
  offers: BookLevel[];
  timestamp: string;
  timestamp_us: number;
}

// One market's price summary on the `ticker` topic's "ticker" push. Any field
// can be null on a market that has not traded or has an empty side of the book.
// `bid_depth`/`offer_depth` are level counts, so plain integers.
export interface TickerUpdate {
  market_id: string;
  market_symbol: string;
  event_id: string;
  event_symbol: string | null;
  sport?: string | null;
  competition?: string | null;
  last_traded_price: string | null;
  last_traded_quantity: string | null;
  best_bid: string | null;
  best_bid_quantity: string | null;
  best_offer: string | null;
  best_offer_quantity: string | null;
  bid_depth: number;
  offer_depth: number;
  open_interest: string | null;
  total_volume: string | null;
  timestamp: string;
  timestamp_us: number;
}

// One execution on the `trades` topic's "trade" push. `action` is the TAKER's
// side: "buy" when the incoming order bought from the book, "sell" otherwise.
export interface TradeMsg {
  market_id: string;
  market_symbol: string;
  event_id: string;
  event_symbol: string | null;
  price: string;
  quantity: string;
  action: "buy" | "sell";
  timestamp: string;
  timestamp_us: number;
}

// ---- Formatting helpers ---------------------------------------------------

// Integer cents -> "$X.XX". Used only for catalog money; live feeds are
// already dollar strings.
export function centsToDollars(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

// A live dollar string, or an em dash when absent.
export function dollars(value: string | null | undefined): string {
  if (value == null || value === "") return "—";
  return value.startsWith("$") ? value : `$${value}`;
}

// Abbreviate a dollar amount for compact display: "$1.00B", "$1.0M", "$12.5K",
// or "$250.00" below 10,000. The input is a plain dollar string (possibly with a
// leading "$"); returns the em dash when it is absent or unparseable. Pair it with
// `moneyTitle` on a `title=` attribute so the exact figure is one hover away.
export function compactMoney(value: string | null | undefined): string {
  const n = parseMoney(value);
  if (n === null) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

// The exact dollar figure, for a `title=` tooltip beside a `compactMoney` value.
export function moneyTitle(value: string | null | undefined): string {
  const n = parseMoney(value);
  return n === null ? "" : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function parseMoney(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// The best display name for a market row.
export function marketLabel(m: MarketSummary): string {
  return m.shortTitle ?? m.title ?? m.symbol ?? m.marketId;
}

// A concise, human label for a market as shown on the cards — a player prop
// reads "Player · Stat line", everything else falls back to the short title.
// Used to name markets in the orders / trades / settlements rows.
export function marketDisplayLabel(m: MarketSummary): string {
  const sd = m.statDetail;
  if (sd?.player) {
    const stat = sd.statDisplayName ?? sd.stat ?? "";
    const line = sd.line != null ? ` ${sd.line}` : "";
    return `${sd.player}${stat ? ` · ${stat}` : ""}${line}`;
  }
  return marketLabel(m);
}

// The best display name for the market's event.
export function eventLabel(m: MarketSummary): string {
  return m.eventShortTitle ?? m.eventTitle ?? "";
}
