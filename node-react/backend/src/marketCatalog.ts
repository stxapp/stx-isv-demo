// The public market catalog, fetched with an APP token and reshaped into what
// the frontend expects.
//
// This replaces the browser's old direct GraphQL `marketInfos` call. STX's REST
// `GET /api/v1/markets` is the app-token surface (scope `market_data`); it
// returns snake_case fields and 4-decimal DOLLAR STRINGS for money. The frontend
// catalog was written against the GraphQL shape: camelCase fields, money in
// INTEGER SUBUNITS (cents), `price` a float. So this module maps REST -> that
// shape, and the frontend renders it unchanged.

import type { Market } from "@stxapp/stx-typescript";
import type { AppProfile } from "./config";
import { stxApp, stxErrorResponse } from "./stx";

// One market in the shape the frontend catalog consumes (the fields the old
// `marketInfos` query produced). Money fields are integer subunits (cents);
// `price` is a float.
export interface CatalogMarket {
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
  // The market's settlement ceiling in cents: 100 = a $1 market, 10000 = $100.
  maxPrice: number | null;
  lastTradedPrice: number | null; // cents
  // 24h traded quantity in contracts (STX returns a quantity string, not money);
  // kept for shape-parity, currently unused by the UI.
  volume24h: number | null;
  specifier: string | null;
  // The event: its teams (away/home, with names and abbreviations), status
  // ("scheduled", "in_progress", ...) and start (epoch ms).
  participants: { role: string | null; name: string | null; shortName: string | null; abbreviation: string | null }[];
  eventStatus: string | null;
  eventStart: number | null;
  // The market's own wording: a one-line description and the question it settles.
  description: string | null;
  question: string | null;
  statDetail: {
    propType: string | null;
    player: string | null;
    stat: string | null;
    statDisplayName: string | null;
    line: number | null;
  } | null;
}

// ---- field coercion --------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

// A 4dp dollar string ("0.4500") -> integer cents (45). null when unparseable.
function dollarsToCents(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(typeof v === "string" ? v : v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

// A dollar string -> float in dollars (the old `price` was a [0,1] float).
function dollarsToFloat(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(typeof v === "string" ? v : v);
  return Number.isFinite(n) ? n : null;
}

// A number or numeric string -> number. null when unparseable.
function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(typeof v === "string" ? v : v);
  return Number.isFinite(n) ? n : null;
}

// An event start (ISO 8601 string, or epoch microseconds as the channels send
// it) -> epoch ms. null when absent or unparseable.
function epochMs(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? Math.floor(v / 1000) : null;
  if (typeof v !== "string" || v === "") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// Map one REST market object to the frontend catalog shape.
function toCatalogMarket(m: Record<string, unknown>): CatalogMarket {
  const sd = m.stat_detail as Record<string, unknown> | null | undefined;
  return {
    marketId: String(m.market_id ?? ""),
    symbol: str(m.symbol),
    title: str(m.title),
    shortTitle: str(m.short_title),
    eventId: str(m.event_id),
    eventTitle: str(m.event_title),
    eventShortTitle: str(m.event_short_title),
    sport: str(m.sport),
    competition: str(m.competition),
    // Already lowercase from STX (e.g. "open", "suspended").
    status: str(m.status),
    price: dollarsToFloat(m.price),
    maxPrice: dollarsToCents(m.max_price),
    lastTradedPrice: dollarsToCents(m.last_traded_price),
    volume24h: num(m.volume24h),
    specifier: str(m.specifier),
    participants: Array.isArray(m.participants)
      ? (m.participants as Record<string, unknown>[]).map((p) => ({
          role: str(p.role),
          name: str(p.name),
          shortName: str(p.short_name),
          abbreviation: str(p.abbreviation),
        }))
      : [],
    eventStatus: str(m.event_status),
    eventStart: epochMs(m.event_start),
    description: str(m.description),
    question: str(m.question),
    statDetail: sd
      ? {
          propType: str(sd.prop_type),
          player: str(sd.player),
          stat: str(sd.stat),
          statDisplayName: str(sd.stat_display_name),
          line: num(sd.line),
        }
      : null,
  };
}

export interface CatalogResult {
  // The upstream HTTP status of the last page fetched (2xx on success).
  status: number;
  markets: CatalogMarket[];
  // The first page as STX returned it (items + cursor), or STX's error body:
  // the activity row's response detail.
  firstPage?: unknown;
}

// Fetch the catalog with the SDK's app-token client, following STX's opaque cursor until we
// have `limit` markets, the collection is exhausted, or a page errors. Bounded
// page count as a safety valve. `status` narrows server-side (e.g. ["open"]).
export async function fetchCatalog(
  app: AppProfile,
  opts: { status: string[]; limit: number },
): Promise<CatalogResult> {
  const { catalog } = stxApp(app);
  const markets: CatalogMarket[] = [];
  let cursor: string | undefined;
  let lastStatus = 0;
  let firstPage: unknown;

  for (let page = 0; page < 20 && markets.length < opts.limit; page++) {
    let items: Market[];
    try {
      const res = await catalog.markets({ status: opts.status, limit: opts.limit, cursor });
      items = res.items;
      cursor = res.cursor ?? undefined;
      if (page === 0) firstPage = { markets: items, cursor: cursor ?? null };
      lastStatus = 200;
    } catch (err) {
      // STX's status for the activity log and the route's answer; 502 when STX
      // could not be reached at all.
      const stxErr = stxErrorResponse(err);
      lastStatus = stxErr?.status ?? 502;
      if (page === 0) firstPage = stxErr?.body ?? { error: (err as Error).message };
      break;
    }
    for (const m of items) markets.push(toCatalogMarket(m as unknown as Record<string, unknown>));
    if (!cursor || items.length === 0) break;
  }

  return { status: lastStatus, markets: markets.slice(0, opts.limit), firstPage };
}

// ---- recent trades ------------------------------------------------------------

// One public trade in the `trades` channel's dollar wire format, so the browser
// renders a REST-seeded row and a live push the same way. `action` is the
// taker's side ("buy" bought from the book, "sell" sold into it).
export interface RecentTradeRow {
  market_id: string;
  price: string;
  quantity: string;
  action: "buy" | "sell";
  timestamp: string;
  timestamp_us: number;
}

// A market's `recent_trades` (the last 15, newest first) -> trade rows. The REST
// field names the side that TOOK liquidity (`buyer` / `seller`), which is the
// channel's `buy` / `sell`. Rows without a price or time are dropped.
export function toTradeRows(marketId: string, recent: unknown): RecentTradeRow[] {
  if (!Array.isArray(recent)) return [];
  const rows: RecentTradeRow[] = [];
  for (const t of recent as Record<string, unknown>[]) {
    const price = str(t?.price);
    const timestamp = str(t?.timestamp);
    if (!price || !timestamp) continue;
    const us = num(t.timestamp_us) ?? Date.parse(timestamp) * 1000;
    rows.push({
      market_id: marketId,
      price,
      quantity: str(t.quantity) ?? "",
      action: t.liquidity_taker === "seller" ? "sell" : "buy",
      timestamp,
      timestamp_us: us,
    });
  }
  return rows.sort((a, b) => b.timestamp_us - a.timestamp_us);
}

export interface RecentTradesResult {
  status: number;
  trades: RecentTradeRow[];
  // What STX returned (the market, or its error body): the activity row's detail.
  body?: unknown;
}

// The market's last trades from `GET /api/v1/markets/{id}` with the app token.
// The public `trades` channel only pushes NEW executions (its join reply carries
// no history), so this is what the tape shows before the next trade.
export async function fetchRecentTrades(app: AppProfile, marketId: string): Promise<RecentTradesResult> {
  try {
    const m = (await stxApp(app).catalog.market(marketId)) as unknown as Record<string, unknown>;
    return { status: 200, trades: toTradeRows(marketId, m.recent_trades), body: { recent_trades: m.recent_trades ?? [] } };
  } catch (err) {
    const stxErr = stxErrorResponse(err);
    return { status: stxErr?.status ?? 502, trades: [], body: stxErr?.body ?? { error: (err as Error).message } };
  }
}
