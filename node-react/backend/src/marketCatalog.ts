// The public market catalog, fetched with an APP token and reshaped into what
// the frontend expects.
//
// The frontend's catalog shape predates this endpoint, so STX's REST
// `GET /api/v1/markets` is the app-token surface (scope `market_data`); it
// returns snake_case fields and 4-decimal DOLLAR STRINGS for money. The frontend
// catalog was written against an older shape: camelCase fields, money in
// INTEGER SUBUNITS (cents), `price` a float. So this module maps REST -> that
// shape, and the frontend renders it unchanged.

import { config, type AppProfile } from "./config";
import { appRequest } from "./appToken";

// One market in the shape the frontend catalog consumes. Money fields are
// integer subunits (cents);
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
}

// Fetch the catalog with an app token, following STX's opaque cursor until we
// have `limit` markets, the collection is exhausted, or a page errors. Bounded
// page count as a safety valve. `status` narrows server-side (e.g. ["open"]).
export async function fetchCatalog(
  app: AppProfile,
  opts: { status: string[]; limit: number },
): Promise<CatalogResult> {
  const markets: CatalogMarket[] = [];
  let cursor: string | null = null;
  let lastStatus = 0;

  for (let page = 0; page < 20 && markets.length < opts.limit; page++) {
    const qs = new URLSearchParams();
    if (opts.status.length) qs.set("status", opts.status.join(","));
    qs.set("limit", String(opts.limit));
    if (cursor) qs.set("cursor", cursor);

    const { status, body } = await appRequest(app, "GET", `${config.paths.markets}?${qs.toString()}`);
    lastStatus = status;
    if (status < 200 || status >= 300) break;

    const b = body as { markets?: unknown[]; cursor?: unknown } | null;
    const raw = Array.isArray(b?.markets) ? b!.markets : [];
    for (const m of raw) markets.push(toCatalogMarket(m as Record<string, unknown>));

    cursor = typeof b?.cursor === "string" && b.cursor !== "" ? b.cursor : null;
    if (!cursor || raw.length === 0) break;
  }

  return { status: lastStatus, markets: markets.slice(0, opts.limit) };
}
