// Public STX market data — no credential of any kind.
//
// Two credential-free surfaces are used, both reached by the browser directly:
//
//   1. Catalog: POST ${VITE_STX_HTTP_URL}/api/graphql, `marketInfos` query.
//      This query carries no `authorize` middleware on the server and is on the
//      response-cache public allowlist, so it resolves for anonymous callers.
//      Money fields come back as INTEGER SUBUNITS (cents); price is a float.
//
//   2. Live feeds: Phoenix channels on ${VITE_STX_WS_URL}/socket — the public
//      `ticker`, `trades`, and `orderbook` topics. These use the "dollar wire
//      format": money and quantities are STRINGS already formatted in dollars,
//      so they render as-is (do NOT divide by 100).
//
// The catalog seeds the list; the channels keep it live.

export const STX_HTTP_URL =
  import.meta.env.VITE_STX_HTTP_URL ?? "http://localhost:4000";
export const STX_WS_URL = import.meta.env.VITE_STX_WS_URL ?? "ws://localhost:4000";

// ---- Catalog (GraphQL `marketInfos`) --------------------------------------

// One market as returned by the public `marketInfos` query. Money fields are
// integer subunits (cents); `price` is a float in [0,1].
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

const MARKET_INFOS_QUERY = `query marketInfos($input: MarketInfosInput) {
  marketInfos(input: $input) {
    marketId
    symbol
    title
    shortTitle
    eventId
    eventTitle
    eventShortTitle
    sport
    competition
    status
    price
    maxPrice
    lastTradedPrice
    volume24h
    specifier
    statDetail {
      propType
      player
      stat
      statDisplayName
      line
    }
  }
}`;

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

// Fetches the public market catalog. `limit` bounds the list (the server treats
// nil/0 as unlimited). Throws with a readable message on transport or GraphQL
// errors so the caller can surface them.
export async function fetchMarkets(limit = 500): Promise<MarketSummary[]> {
  const res = await fetch(`${STX_HTTP_URL}/api/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operationName: "marketInfos",
      // Only OPEN markets are tradeable; ask STX to filter server-side so the
      // 500-per-request cap is spent on markets we actually show.
      query: MARKET_INFOS_QUERY,
      variables: { input: { status: ["OPEN"], limit } },
    }),
  });

  if (!res.ok) {
    throw new Error(`STX GraphQL responded ${res.status}`);
  }

  const body = (await res.json()) as GraphQLResponse<{
    marketInfos: MarketSummary[] | null;
  }>;

  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }

  return body.data?.marketInfos ?? [];
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

// Integer cents -> "$X.XX". Used only for catalog (GraphQL) money; live feeds are
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
