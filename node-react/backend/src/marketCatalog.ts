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

// STX's page size cap for `GET /api/v1/markets`.
export const PAGE_SIZE = 200;
// Safety valve: stop after this many markets (50 pages) and flag the result.
export const MAX_MARKETS = 50 * PAGE_SIZE;
// How long one fetched catalog is served before the next request refetches it.
export const CATALOG_TTL_MS = 60_000;

// The query every catalog fetch sends: only OPEN markets are tradeable and have
// a live book, so STX filters server-side.
export const CATALOG_QUERY = { status: ["open"], limit: PAGE_SIZE };

export interface CatalogResult {
  // STX's HTTP status: 200 when every page came back, else the failing page's
  // status (502 when STX could not be reached).
  status: number;
  markets: CatalogMarket[];
  // Pages read, including a failing one.
  pages: number;
  // True when MAX_MARKETS stopped the walk before the cursor ran out.
  truncated: boolean;
  // The first page as STX returned it, or STX's error body when the first page
  // failed: the activity row's response detail.
  firstPage?: unknown;
}

// The part of the SDK client the catalog walk uses (a stub in tests).
export interface CatalogClient {
  iterMarkets(query: typeof CATALOG_QUERY): AsyncIterable<Market>;
}

// Read every open market, letting the SDK's `iterMarkets` follow STX's opaque
// cursor page by page. A page that fails part-way keeps the markets read so far
// and reports that page's status; the caller decides whether a partial catalog
// is usable.
export async function fetchAllMarkets(client: CatalogClient): Promise<CatalogResult> {
  const markets: CatalogMarket[] = [];
  const first: unknown[] = [];
  let status = 200;
  let truncated = false;
  let firstPage: unknown;

  try {
    for await (const m of client.iterMarkets(CATALOG_QUERY)) {
      if (markets.length >= MAX_MARKETS) {
        truncated = true;
        break;
      }
      if (first.length < PAGE_SIZE) first.push(m);
      markets.push(toCatalogMarket(m as unknown as Record<string, unknown>));
    }
  } catch (err) {
    const stxErr = stxErrorResponse(err);
    status = stxErr?.status ?? 502;
    if (markets.length === 0) firstPage = stxErr?.body ?? { error: (err as Error).message };
  }

  if (firstPage === undefined) firstPage = { markets: first };
  const pages = Math.max(1, Math.ceil(markets.length / PAGE_SIZE) + (status === 200 ? 0 : 1));
  return { status, markets, pages, truncated, firstPage };
}

// Every open market for one app profile, read with its app token.
export function fetchCatalog(app: AppProfile): Promise<CatalogResult> {
  return fetchAllMarkets(stxApp(app).catalog);
}

// The JSON the route sends for a catalog, serialized and gzipped once per fetch
// rather than once per request: 5,000 markets are about 10 MB of JSON and about
// 0.5 MB gzipped.
export interface CatalogBody {
  json: string;
  gzip: Uint8Array;
}

export function encodeCatalog(result: CatalogResult): CatalogBody {
  const json = JSON.stringify({ markets: result.markets, truncated: result.truncated });
  return { json, gzip: Bun.gzipSync(json) };
}

export interface CachedCatalog {
  // What to serve: the last complete fetch, or, with none yet, whatever the
  // failed fetch read.
  result: CatalogResult;
  // The encoded response, when `result` is a cached complete fetch.
  body?: CatalogBody;
  // True when the latest refetch failed and an older catalog is served.
  stale: boolean;
}

// One catalog per app profile. Only the first request (or one after a failed
// first fetch) waits for STX: once a complete catalog is cached, a request past
// `ttlMs` is served the cached one at once and starts a refetch in the
// background. Concurrent requests share one fetch. Only a complete fetch is
// cached. `onFetched` sees every fetch (for the activity log).
export class CatalogCache {
  #entry: { at: number; result: CatalogResult; body: CatalogBody } | undefined;
  #inflight: Promise<CachedCatalog> | undefined;
  #lastFailed = false;

  constructor(
    private readonly load: () => Promise<CatalogResult>,
    private readonly ttlMs = CATALOG_TTL_MS,
    private readonly now: () => number = Date.now,
    private readonly onFetched: (fetched: CatalogResult) => void = () => {},
  ) {}

  async get(): Promise<CachedCatalog> {
    const entry = this.#entry;
    if (entry) {
      if (this.now() - entry.at >= this.ttlMs) this.refresh().catch(() => {});
      return { result: entry.result, body: entry.body, stale: this.#lastFailed };
    }
    return this.refresh();
  }

  // Fetch now, or join the fetch already running.
  refresh(): Promise<CachedCatalog> {
    if (!this.#inflight) {
      this.#inflight = this.#refetch().finally(() => {
        this.#inflight = undefined;
      });
    }
    return this.#inflight;
  }

  async #refetch(): Promise<CachedCatalog> {
    const fetched = await this.load();
    this.onFetched(fetched);
    if (fetched.status === 200) {
      this.#entry = { at: this.now(), result: fetched, body: encodeCatalog(fetched) };
      this.#lastFailed = false;
      return { result: fetched, body: this.#entry.body, stale: false };
    }
    this.#lastFailed = true;
    if (this.#entry) return { result: this.#entry.result, body: this.#entry.body, stale: true };
    return { result: fetched, stale: false };
  }
}

const caches = new Map<string, CatalogCache>();

// The shared catalog cache for an app profile. `onFetched` is set by the first
// caller (the /api/markets route, and the warm-up at boot, pass the same one).
export function catalogCacheFor(app: AppProfile, onFetched?: (fetched: CatalogResult) => void): CatalogCache {
  let cache = caches.get(app.id);
  if (!cache) {
    cache = new CatalogCache(() => fetchCatalog(app), CATALOG_TTL_MS, Date.now, onFetched);
    caches.set(app.id, cache);
  }
  return cache;
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
