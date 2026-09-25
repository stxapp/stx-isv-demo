// Live PUBLIC market feed: the ISV backend joins STX's public market channels
// with an APP token and relays their events to the browser.
//
// This is the market-data twin of liveProxy.ts. Same reason for a backend proxy:
// STX authenticates a socket with the `x-stx-oauth-token` HEADER on the WS
// handshake, which a browser cannot set (and must never hold the token anyway),
// but this backend can. The difference from the member feed:
//
//   - the token is the app's own APP token (client_credentials, scope
//     `market_data`), NOT a member's access token, so no member is involved;
//   - the topics are the public market channels, joined with per-subscription
//     params (a market_ids filter, a stats range) rather than fixed `<uid>` topics.
//
// One STX socket is opened per browser subscription (one EventSource ->
// GET /api/market-stream -> one subscribeMarket -> one STX socket joined to one
// topic). Market channels push a fresh snapshot on join (orderbook) or carry
// history in the join reply (market_stats), so a per-subscription socket gets the
// correct initial state every time.
//
// The socket is the SDK's `STXWebSocket` on the app's catalog client: the first
// connect uses the cached app token, every reconnect mints a fresh one, and it
// rejoins the topic with its filters after a drop.

import { ReconnectPolicy, STXChannelException, type Channel, type ChannelMessage } from "@stxapp/stx-typescript";
import type { AppProfile } from "./config";
import { safeBody, listSummary, type ActivityDetail } from "./activityDetail";
import { sdkCalls } from "./sdkCall";
import { activityStore } from "./stores";
import { MARKET_DATA_SCOPE, stxApp } from "./stx";

export type MarketTopic = "ticker" | "trades" | "orderbook" | "market_stats" | "market";

// The public market channels. `orderbook`, `trades` and `market_stats` are
// narrowed by a `market_ids` list; `ticker` is joined unfiltered for a
// market-wide change feed (the server treats no filter as "all markets").
// `market` joins `market:<id>` once per listed market (see subscribeBriefs).
export const MARKET_TOPICS: readonly MarketTopic[] = ["ticker", "trades", "orderbook", "market_stats", "market"];

// At most this many `market:<id>` joins per `market` subscription: the browser
// asks for one market per live event, and this keeps the socket light.
export const MAX_BRIEF_MARKETS = 12;

export interface MarketSubscription {
  topic: MarketTopic;
  // The markets to narrow to (required for orderbook/trades/market_stats; ignored
  // for the market-wide ticker).
  marketIds: string[];
  // market_stats only: the price-history window ("day" | "week" | "month" | "all").
  range?: string | null;
}

// One relayed event. `event` is the Phoenix push name (`book`, `ticker`,
// `trade`, `market_stats`, `market_stats_snapshot`), or the synthetic `joined`
// (the join reply, which carries market_stats history) / `join_error`.
export interface MarketEvent {
  event: string;
  payload: unknown;
  ts: number;
}

type Listener = (e: MarketEvent) => void;

const QUIET_LOGGER = { debug() {}, info() {}, warn() {}, error() {} };

// Reconnect pacing: 1 s doubling to a 30 s cap, jittered.
const RECONNECT = new ReconnectPolicy({ initialBackoffMs: 1000, maxBackoffMs: 30_000 });

// Subscribe to a public market topic with an app token. Returns an unsubscribe
// fn that tears the STX socket down. One call == one STX socket for that
// subscription's lifetime.
export function subscribeMarket(app: AppProfile, sub: MarketSubscription, listener: Listener): () => void {
  if (sub.topic === "market") return subscribeBriefs(app, sub, listener);
  // One row per subscription, written once the join is answered: the join
  // payload and the join reply (or the refusal) are its detail.
  const logJoin = (ok: boolean, reply: unknown) =>
    activityStore.record({
      ts: Date.now(),
      appId: app.id,
      method: "WS",
      path: `/socket (${sub.topic})`,
      status: null,
      note: ok ? "Opened market feed" : "Market feed join refused",
      sdkCall: sdkCalls.marketJoin(MARKET_DATA_SCOPE, sub),
      detail: joinDetail(sub, ok, reply),
    });
  let torn = false;
  let channel: Channel | null = null;
  const emit = (event: string, payload: unknown) => {
    if (!torn) listener({ event, payload, ts: Date.now() });
  };
  const ws = stxApp(app).catalog.websocket({
    logger: QUIET_LOGGER,
    reconnectPolicy: RECONNECT,
    // A rejoin after a reconnect carries a fresh join reply (market_stats
    // history): relay it like the first one.
    onReconnect: () => {
      if (channel) emit("joined", channel.reply);
    },
  });
  const onMessage = (m: ChannelMessage) => emit(m.event, m.payload);

  void (async () => {
    try {
      if (sub.topic === "orderbook") channel = await ws.orderbook(sub.marketIds, { onMessage });
      else if (sub.topic === "trades") channel = await ws.trades({ marketIds: sub.marketIds, onMessage });
      else if (sub.topic === "market_stats") {
        channel = await ws.marketStats(sub.marketIds, { range: sub.range ?? "all", onMessage });
      } else channel = await ws.ticker({ onMessage });
      emit("joined", channel.reply);
      logJoin(true, channel.reply);
    } catch (err) {
      // A refused join carries STX's reply (`{reason}`); relay it as before.
      const reply = err instanceof STXChannelException ? err.reply : undefined;
      emit("join_error", reply ?? { reason: (err as Error).message });
      logJoin(false, reply ?? { reason: (err as Error).message });
    }
  })();

  return () => {
    torn = true;
    void ws.close();
  };
}

// The join sent and the reply STX gave, for the activity row. Topics are the
// SDK's: one channel per market for the book and stats, one for the ticker.
function joinDetail(sub: MarketSubscription, ok: boolean, reply: unknown): ActivityDetail {
  const summary = ok ? (listSummary(reply) ?? "joined") : "join refused";
  return {
    request: {
      method: "JOIN",
      path: `${sub.topic} (app token, scope ${MARKET_DATA_SCOPE})`,
      ...safeBody({ topic: sub.topic, market_ids: sub.marketIds, ...(sub.range ? { range: sub.range } : {}) }),
    },
    response: { status: null, summary, ...safeBody(reply ?? {}) },
  };
}

// ---- Live event status (scores) ----------------------------------------------

// The fields of a `market:<id>` payload that describe the market's EVENT as it
// stands: the status text (`event_brief`, the score and clock while in play, the
// start time before), its longer form, and the event status.
const BRIEF_KEYS = ["event_brief", "detailed_event_brief", "event_status", "status"] as const;

// One market's event status, as relayed to the browser in a `brief` event.
export interface MarketBrief {
  market_id: string;
  event_id: string | null;
  event_brief: string | null;
  detailed_event_brief: string | null;
  event_status: string | null;
  status: string | null;
}

// The brief fields of a join reply or `market_update` diff, merged over what
// was known. Null when the payload changes none of them.
export function briefFrom(prev: MarketBrief | undefined, marketId: string, payload: unknown): MarketBrief | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (prev && !BRIEF_KEYS.some((k) => k in p)) return null;
  const pick = (k: string, fallback: string | null) => (k in p ? ((p[k] as string | null) ?? null) : fallback);
  return {
    market_id: marketId,
    event_id: pick("event_id", prev?.event_id ?? null),
    event_brief: pick("event_brief", prev?.event_brief ?? null),
    detailed_event_brief: pick("detailed_event_brief", prev?.detailed_event_brief ?? null),
    event_status: pick("event_status", prev?.event_status ?? null),
    status: pick("status", prev?.status ?? null),
  };
}

// Live event status for a set of markets: one socket, one `market:<id>` join per
// market (the SDK's `ws.market()`, open to the app token's `market_data`). Each
// join reply is the market's whole state; only its event status is relayed, as
// a `brief` event, and again whenever a `market_update` changes it. The ~200 ms
// `order_book_update` pushes on the same topic are not relayed. After a
// reconnect the SDK rejoins and each fresh reply is relayed again.
function subscribeBriefs(app: AppProfile, sub: MarketSubscription, listener: Listener): () => void {
  const ids = [...new Set(sub.marketIds)].slice(0, MAX_BRIEF_MARKETS);
  const briefs = new Map<string, MarketBrief>();
  const channels = new Map<string, Channel>();
  let torn = false;
  const relay = (marketId: string, payload: unknown) => {
    const next = briefFrom(briefs.get(marketId), marketId, payload);
    if (!next || torn) return;
    briefs.set(marketId, next);
    listener({ event: "brief", payload: next, ts: Date.now() });
  };
  const ws = stxApp(app).catalog.websocket({
    logger: QUIET_LOGGER,
    reconnectPolicy: RECONNECT,
    onReconnect: () => {
      for (const [id, ch] of channels) relay(id, ch.reply);
    },
  });

  void (async () => {
    const refused: Record<string, unknown> = {};
    for (const id of ids) {
      try {
        const ch = await ws.market(id, {
          onMessage: (m: ChannelMessage) => {
            if (m.event === "market_update") relay(id, m.payload);
          },
        });
        channels.set(id, ch);
        relay(id, ch.reply);
      } catch (err) {
        // A market that closed or resulted since the catalog loaded is refused
        // (`market_not_joinable`); the others still stream.
        const reply = err instanceof STXChannelException ? err.reply : { reason: (err as Error).message };
        refused[id] = reply;
        if (!torn) listener({ event: "join_error", payload: { market_id: id, ...(reply as object) }, ts: Date.now() });
      }
    }
    if (torn) return;
    listener({ event: "joined", payload: { markets: channels.size }, ts: Date.now() });
    activityStore.record({
      ts: Date.now(),
      appId: app.id,
      method: "WS",
      path: "/socket (market)",
      status: null,
      note: channels.size
        ? `Opened live scores for ${channels.size} market${channels.size === 1 ? "" : "s"}`
        : "Live scores join refused",
      sdkCall: sdkCalls.marketJoin(MARKET_DATA_SCOPE, { ...sub, marketIds: ids }),
      detail: {
        request: {
          method: "JOIN",
          path: `market:<id> x${ids.length} (app token, scope ${MARKET_DATA_SCOPE})`,
          ...safeBody({ topics: ids.map((id) => `market:${id}`) }),
        },
        response: {
          status: null,
          summary: `${channels.size} joined, ${Object.keys(refused).length} refused; event status relayed`,
          ...safeBody({ briefs: [...briefs.values()], refused }),
        },
      },
    });
  })();

  return () => {
    torn = true;
    void ws.close();
  };
}
