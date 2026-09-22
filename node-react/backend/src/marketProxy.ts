// Live PUBLIC market feed: the ISV backend joins STX's public market channels
// with an APP token and relays their events to the browser.
//
// This is the market-data twin of liveProxy.ts. Same reason for a backend proxy:
// STX authenticates a socket with the `x-stx-oauth-token` HEADER on the WS
// handshake, which a browser cannot set (and must never hold the token anyway),
// but this backend can. The difference from the member feed:
//
//   - the token is an APP token (client_credentials, scope `market_data`) from
//     appToken.ts, NOT a member's access token — so no member is involved;
//   - the topics are the public market channels, joined with per-subscription
//     params (a market_ids filter, a stats range) rather than fixed `<uid>` topics.
//
// One STX socket is opened per browser subscription (one EventSource ->
// GET /api/market-stream -> one subscribeMarket -> one STX socket joined to one
// topic). Market channels push a fresh snapshot on join (orderbook) or carry
// history in the join reply (market_stats), so a per-subscription socket gets the
// correct initial state every time — no shared-connection replay to reason about.
//
// The socket speaks the Phoenix v2 wire protocol directly (a JSON array
// [join_ref, ref, topic, event, payload]); no phoenix client dependency.

import { config, type AppProfile } from "./config";
import { appToken, freshAppToken } from "./appToken";

export type MarketTopic = "ticker" | "trades" | "orderbook" | "market_stats";

// The public market channels, and which join params each carries. `orderbook`,
// `trades` and `market_stats` are narrowed by a `market_ids` list; `ticker` is
// joined unfiltered for a market-wide change feed (the server treats no filter as
// "all markets").
export const MARKET_TOPICS: readonly MarketTopic[] = ["ticker", "trades", "orderbook", "market_stats"];

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
// (the join reply — carries market_stats history) / `join_error`.
export interface MarketEvent {
  event: string;
  payload: unknown;
  ts: number;
}

type Listener = (e: MarketEvent) => void;

interface Conn {
  app: AppProfile;
  sub: MarketSubscription;
  ws: WebSocket | null;
  listeners: Set<Listener>;
  heartbeat: ReturnType<typeof setInterval> | null;
  reconnect: ReturnType<typeof setTimeout> | null;
  ref: number;
  joinRef: string | null;
  torn: boolean;
}

function socketUrl(): string {
  const base = config.stxBaseUrl.replace(/^http/, "ws");
  return `${base}/socket/websocket?vsn=2.0.0`;
}

// The join payload for a topic. STX requires a non-empty `market_ids` on
// orderbook; trades/market_stats accept it as a filter; ticker takes no filter
// (market-wide). `range` defaults to "all" server-side when omitted.
function joinParams(sub: MarketSubscription): Record<string, unknown> {
  switch (sub.topic) {
    case "orderbook":
    case "trades":
      return { market_ids: sub.marketIds };
    case "market_stats":
      return { market_ids: sub.marketIds, range: sub.range ?? "all" };
    case "ticker":
      return {};
  }
}

function emit(conn: Conn, e: MarketEvent): void {
  for (const l of conn.listeners) l(e);
}

function connect(conn: Conn, fresh = false): void {
  // Mint (or re-mint) the app token, then open the socket with it on the
  // handshake header. Done inside a void async IIFE so the caller doesn't block
  // on the token round-trip (mirrors liveProxy's fire-and-forget connect).
  void (async () => {
    let token: string;
    try {
      token = fresh ? await freshAppToken(conn.app) : await appToken(conn.app);
    } catch {
      // Couldn't mint — retry the whole connect shortly if anyone still listens.
      scheduleReconnect(conn);
      return;
    }
    if (conn.torn) return;

    // Bun's WebSocket accepts a `headers` option (not in the DOM lib types).
    const ws = new WebSocket(socketUrl(), {
      headers: { "x-stx-oauth-token": token },
    } as unknown as string[]);
    conn.ws = ws;

    ws.addEventListener("open", () => {
      // v2 frame: [join_ref, ref, topic, event, payload]. join_ref === ref on join.
      const ref = String(++conn.ref);
      conn.joinRef = ref;
      ws.send(JSON.stringify([ref, ref, conn.sub.topic, "phx_join", joinParams(conn.sub)]));
      conn.heartbeat = setInterval(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify([null, String(++conn.ref), "phoenix", "heartbeat", {}]));
      }, 30000);
    });

    ws.addEventListener("message", (ev: MessageEvent) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!Array.isArray(frame)) return;
      const [, , topic, event, payload] = frame as [unknown, unknown, string, string, unknown];
      if (typeof topic !== "string" || typeof event !== "string") return;
      // Only this topic's frames — skips the "phoenix" heartbeat replies.
      if (topic !== conn.sub.topic) return;

      if (event === "phx_reply") {
        // The join reply. For market_stats it carries the price-history seed
        // (`markets: [...]`); for the others an ack. Relay it as `joined`.
        const p = payload as { status?: string; response?: unknown };
        emit(conn, {
          event: p?.status === "ok" ? "joined" : "join_error",
          payload: p?.response ?? {},
          ts: Date.now(),
        });
        return;
      }
      // Skip the remaining protocol control frames (phx_error / phx_close).
      if (event.startsWith("phx_")) return;

      emit(conn, { event, payload, ts: Date.now() });
    });

    const drop = () => {
      if (conn.heartbeat) {
        clearInterval(conn.heartbeat);
        conn.heartbeat = null;
      }
      conn.ws = null;
      scheduleReconnect(conn);
    };
    ws.addEventListener("close", drop);
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    });
  })();
}

// Reconnect while anyone is still listening (token rotated / STX blip). Always
// re-mints a fresh token — never reuse the token from the socket that dropped.
function scheduleReconnect(conn: Conn): void {
  if (conn.torn || conn.listeners.size === 0 || conn.reconnect) return;
  conn.reconnect = setTimeout(() => {
    conn.reconnect = null;
    if (!conn.torn && conn.listeners.size > 0) connect(conn, true);
  }, 2000);
}

function teardown(conn: Conn): void {
  conn.torn = true;
  if (conn.heartbeat) clearInterval(conn.heartbeat);
  if (conn.reconnect) clearTimeout(conn.reconnect);
  try {
    conn.ws?.close();
  } catch {
    /* ignore */
  }
}

// Subscribe to a public market topic with an app token. Returns an unsubscribe
// fn that tears the STX socket down. One call == one STX socket for that
// subscription's lifetime.
export function subscribeMarket(
  app: AppProfile,
  sub: MarketSubscription,
  listener: Listener,
): () => void {
  const conn: Conn = {
    app,
    sub,
    ws: null,
    listeners: new Set([listener]),
    heartbeat: null,
    reconnect: null,
    ref: 0,
    joinRef: null,
    torn: false,
  };
  connect(conn);
  return () => {
    conn.listeners.delete(listener);
    teardown(conn);
  };
}
