// Live market data over the backend SSE proxy.
//
// The browser no longer opens a Phoenix socket to STX. Instead each of these
// helpers opens ONE EventSource to the backend's GET /api/market-stream, which
// holds the app-token-authenticated STX socket and relays the channel's pushes
// as named SSE events. One helper call == one topic subscription; the returned
// function closes it.
//
// The relayed SSE event names are the Phoenix push names (`book`, `ticker`,
// `trade`, `market_stats`, `market_stats_snapshot`), plus `joined` (the join
// reply: carries market_stats history), `join_error`, and `ready` (the backend
// subscribed). Each event's `data` is the raw channel payload, so the payload
// types in publicMarketData.ts are unchanged.

import { BACKEND } from "./api";
import type { BookSnapshot, MarketBrief, TickerUpdate, TradeMsg } from "./publicMarketData";

export type FeedStatus = "connecting" | "open" | "error";

function streamUrl(topic: string, params: { marketIds?: string[]; range?: string }): string {
  const qs = new URLSearchParams({ topic });
  if (params.marketIds && params.marketIds.length > 0) qs.set("market_ids", params.marketIds.join(","));
  if (params.range) qs.set("range", params.range);
  return `${BACKEND}/api/market-stream?${qs.toString()}`;
}

// Parse an SSE event's JSON `data` into T, or null on a malformed frame.
function payloadOf<T>(ev: MessageEvent): T | null {
  try {
    return JSON.parse(ev.data) as T;
  } catch {
    return null;
  }
}

function on(es: EventSource, name: string, fn: (ev: MessageEvent) => void): void {
  es.addEventListener(name, fn as EventListener);
}

// ---- Ticker: market-wide change feed --------------------------------------

// Subscribe to the market-wide `ticker` feed (no filter). `onStatus` mirrors the
// old socket's connection state for the "● live" indicator.
export function subscribeTicker(
  onTicker: (t: TickerUpdate) => void,
  onStatus?: (s: FeedStatus) => void,
): () => void {
  const es = new EventSource(streamUrl("ticker", {}), { withCredentials: true });
  onStatus?.("connecting");
  on(es, "ready", () => onStatus?.("open"));
  on(es, "ticker", (ev) => {
    const p = payloadOf<TickerUpdate>(ev);
    if (p) onTicker(p);
  });
  es.onerror = () => onStatus?.("error");
  return () => es.close();
}

// ---- Order book: full snapshots for one market ----------------------------

// Subscribe to one market's `orderbook`. Each `book` push is a COMPLETE
// snapshot (replace wholesale). `onJoined`/`onError` mirror the old channel
// join ok/error.
export function subscribeOrderBook(
  marketId: string,
  handlers: {
    onBook: (b: BookSnapshot) => void;
    onJoined?: () => void;
    onError?: (reason: string) => void;
  },
): () => void {
  const es = new EventSource(streamUrl("orderbook", { marketIds: [marketId] }), { withCredentials: true });
  on(es, "joined", () => handlers.onJoined?.());
  on(es, "join_error", (ev) => {
    const p = payloadOf<{ reason?: string }>(ev);
    handlers.onError?.(p?.reason ?? "join failed");
  });
  on(es, "book", (ev) => {
    const p = payloadOf<BookSnapshot>(ev);
    if (p) handlers.onBook(p);
  });
  // A join failure (relayed above) is a real error; EventSource transport blips
  // auto-reconnect and re-`joined`, so they are not surfaced as book errors.
  return () => es.close();
}

// ---- Trades: executions for one market ------------------------------------

// Subscribe to one market's `trades` tape. Each `trade` push is one execution.
export function subscribeTrades(
  marketId: string,
  handlers: {
    onTrade: (t: TradeMsg) => void;
    onJoined?: () => void;
  },
): () => void {
  const es = new EventSource(streamUrl("trades", { marketIds: [marketId] }), { withCredentials: true });
  on(es, "joined", () => handlers.onJoined?.());
  on(es, "trade", (ev) => {
    const p = payloadOf<TradeMsg>(ev);
    if (p) handlers.onTrade(p);
  });
  return () => es.close();
}

// ---- Market stats: price-history series -----------------------------------

// One market's price-history bucket list, as carried by the `market_stats`
// channel (join reply `markets`, plus `market_stats` deltas and
// `market_stats_snapshot` replacements).
export interface StatsMarketPayload {
  market_id?: string;
  points?: Array<{ timestamp_us?: number | string; price_percent?: number | string }>;
}

// Subscribe to the `market_stats` price history for a set of markets at a range.
//   - `onSeed` fires once on join with the whole history (join reply `markets`);
//   - `onSnapshot` replaces one market's series wholesale;
//   - `onDelta` upserts changed buckets for one market.
export function subscribeMarketStats(
  marketIds: string[],
  range: string,
  handlers: {
    onSeed: (markets: StatsMarketPayload[]) => void;
    onSnapshot: (m: StatsMarketPayload) => void;
    onDelta: (m: StatsMarketPayload) => void;
    onStatus?: (s: FeedStatus) => void;
  },
): () => void {
  const es = new EventSource(streamUrl("market_stats", { marketIds, range }), { withCredentials: true });
  handlers.onStatus?.("connecting");
  on(es, "joined", (ev) => {
    const p = payloadOf<{ markets?: StatsMarketPayload[] }>(ev);
    handlers.onSeed(p?.markets ?? []);
    handlers.onStatus?.("open");
  });
  on(es, "join_error", () => handlers.onStatus?.("error"));
  on(es, "market_stats_snapshot", (ev) => {
    const p = payloadOf<StatsMarketPayload>(ev);
    if (p) handlers.onSnapshot(p);
  });
  on(es, "market_stats", (ev) => {
    const p = payloadOf<StatsMarketPayload>(ev);
    if (p) handlers.onDelta(p);
  });
  es.onerror = () => handlers.onStatus?.("error");
  return () => es.close();
}

// ---- Live event status (scores) ---------------------------------------------

// Subscribe to the live event status of a few markets (one per live event; the
// backend caps the list at 12). Each `brief` is one market's event status, on
// join and again whenever the score, clock or status changes.
export function subscribeBriefs(marketIds: string[], onBrief: (b: MarketBrief) => void): () => void {
  if (marketIds.length === 0) return () => {};
  const es = new EventSource(streamUrl("market", { marketIds }), { withCredentials: true });
  on(es, "brief", (ev) => {
    const p = payloadOf<MarketBrief>(ev);
    if (p) onBrief(p);
  });
  return () => es.close();
}
