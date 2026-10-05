// STX market data: served entirely through the ISV backend now.
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
// The catalog seeds the list; the SSE feeds keep it live. The exchange's own
// address (`stxUrl()`) is used only for what the browser loads from the exchange
// itself: the deposit popup, the "powered by" link and the sport icons. It comes
// from the backend at runtime (GET /api/app), so moving hosts needs no rebuild.

import { BACKEND } from "./api";

let stxPublicUrl = (import.meta.env.VITE_STX_HTTP_URL ?? "http://localhost:4000").replace(/\/+$/, "");

// Set once from GET /api/app (the backend's STX_PUBLIC_URL).
export function setStxUrl(url: string | null | undefined): void {
  if (url) stxPublicUrl = url.replace(/\/+$/, "");
}

// The exchange's public origin, e.g. https://stx-sandbox.example.com.
export function stxUrl(): string {
  return stxPublicUrl;
}

// The exchange's host name for display ("stx-sandbox.example.com"), so the app
// can say which STX environment its data comes from.
export function stxHost(url: string = stxPublicUrl): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// The exchange-served icon for a sport ("Baseball" -> .../baseball.svg). The
// exchange answers an unknown sport with its generic icon, so any name is safe.
// These are the only sports images the exchange serves: it has no team or
// league logos (see README, "Exchange gaps").
export function sportIconUrl(sport: string | null | undefined): string {
  const name = (sport ?? "general").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || "general";
  return `${stxPublicUrl}/api/images/categories/standard/${encodeURIComponent(name)}.svg`;
}

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
  // The event's teams (away first, then home), status and start (epoch ms).
  participants: Participant[];
  eventStatus: string | null;
  eventStart: number | null;
  // The market's own wording: what it settles on, as a sentence and a question.
  description: string | null;
  question: string | null;
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

export interface Participant {
  role: string | null; // "away" | "home"
  name: string | null;
  shortName: string | null;
  abbreviation: string | null;
}

// Fetches the market catalog from the backend: every open market. The backend
// walks STX's pages, caches the result for a minute, and reshapes STX's REST
// response into `MarketSummary`. Sends the session cookie + active app (same as
// every /api call) so the read is attributed to the right app profile. Throws
// with a readable message on transport errors so the caller can surface them.
export async function fetchMarkets(): Promise<MarketSummary[]> {
  const res = await fetch(`${BACKEND}/api/markets`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(`Market catalog responded ${res.status}`);
  }

  const body = (await res.json()) as { markets?: MarketSummary[] };
  return body.markets ?? [];
}

// A market's recent public trades (the last 15, newest first) from the backend
// (GET /api/markets/:id/trades, the market's REST `recent_trades`), already in
// the `trades` channel's row shape. The live feed only pushes trades made after
// it joins, so this seeds the tape. Throws on a transport or upstream error.
export async function fetchRecentTrades(marketId: string): Promise<TradeMsg[]> {
  const res = await fetch(`${BACKEND}/api/markets/${encodeURIComponent(marketId)}/trades`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Recent trades responded ${res.status}`);
  const body = (await res.json()) as { trades?: TradeMsg[] };
  return body.trades ?? [];
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

// A full snapshot of one market's book. NOT a delta: replace wholesale on each
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
  // Absent on rows seeded from REST (GET /api/markets/:id/trades).
  market_symbol?: string;
  event_id?: string;
  event_symbol?: string | null;
  price: string;
  quantity: string;
  action: "buy" | "sell";
  timestamp: string;
  timestamp_us: number;
}

// ---- Formatting helpers ---------------------------------------------------

// Integer cents -> "$X,XXX.XX". Used only for catalog money; live feeds are
// already dollar strings.
export function centsToDollars(cents: number | null | undefined): string {
  if (cents == null) return "-";
  return formatMoney(cents / 100);
}

// A live dollar string, or an em dash when absent.
export function dollars(value: string | null | undefined): string {
  if (value == null || value === "") return "-";
  return value.startsWith("$") ? value : `$${value}`;
}

// A dollar amount in full, with thousands separators and cents: "$100,000.00",
// "-$24.75". The input is a dollar string (a leading "$" and commas are fine) or
// a number of dollars; returns an en dash when absent or unparseable. This is
// how every balance is shown: a wallet never abbreviates.
export function formatMoney(value: string | number | null | undefined): string {
  const n = typeof value === "number" ? (Number.isFinite(value) ? value : null) : parseMoney(value);
  if (n === null) return "–";
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "-" : ""}$${abs}`;
}

// Abbreviate a dollar amount for a tight chip only (market volume): "$1.00B",
// "$1.00M", "$12.5K", or the full amount below 10,000. Never for a balance; see
// `formatMoney`. Pair it with `moneyTitle` so the exact figure is one hover away.
export function compactMoney(value: string | null | undefined): string {
  const n = parseMoney(value);
  if (n === null) return "-";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return formatMoney(n);
}

// The exact dollar figure, for a `title=` tooltip beside a `compactMoney` value.
export function moneyTitle(value: string | null | undefined): string {
  const n = parseMoney(value);
  return n === null ? "" : formatMoney(n);
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

// A concise, human label for a market as shown on the cards: a player prop
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

// ---- Events: teams, status, live score ------------------------------------

// One market's event status from GET /api/market-stream?topic=market (the
// exchange's `market:<id>` channel): `event_brief` is the score and clock while
// the game is on ("CHC 3 - 4 BOS : Bottom 8th 1 Outs"), the start time before.
export interface MarketBrief {
  market_id: string;
  event_id: string | null;
  event_brief: string | null;
  detailed_event_brief: string | null;
  event_status: string | null;
  status: string | null;
}

// The two sides of an event, away first ("CHC @ BOS"), or [] when the market
// names no teams (a futures or novelty market).
export function teams(m: Pick<MarketSummary, "participants">): Participant[] {
  const away = m.participants.find((p) => p.role === "away");
  const home = m.participants.find((p) => p.role === "home");
  if (away && home) return [away, home];
  return m.participants.slice(0, 2);
}

export function isLive(status: string | null | undefined): boolean {
  return status === "in_progress" || status === "live";
}

// A scheduled event's start, in the viewer's time: "Today 7:05 PM",
// "Tomorrow 1:00 PM", "Wed Oct 1, 9:30 PM".
export function startLabel(ms: number | null | undefined, now = Date.now()): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = (t: number) => new Date(t).toDateString();
  if (day(ms) === day(now)) return `Today ${time}`;
  if (day(ms) === day(now + 86_400_000)) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, ${time}`;
}

// The live score from a brief, without the clock: "CHC 3 - 4 BOS : Bottom 8th"
// -> { score: "CHC 3 - 4 BOS", clock: "Bottom 8th" }. The exchange writes the
// score first and the period after a colon; anything else is shown whole.
export function splitBrief(brief: string | null | undefined): { score: string; clock: string | null } | null {
  if (!brief) return null;
  const i = brief.indexOf(" : ");
  if (i < 0) return { score: brief.trim(), clock: null };
  return { score: brief.slice(0, i).trim(), clock: brief.slice(i + 3).trim() || null };
}
