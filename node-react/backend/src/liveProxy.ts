// Live member feed: the ISV backend joins the member's private STX channels and
// relays their events to the browser.
//
// Why a backend proxy: STX authenticates a socket with the `x-stx-oauth-token`
// HEADER on the WS handshake. A browser cannot set WS headers (and must never
// hold the token anyway), but this backend can — so it opens ONE authenticated
// socket per linked member, joins the member's topics, and fans the events out
// to that member's browser tabs over SSE (see GET /api/stream).
//
// Topics (STX dollar-string OAuth vocabulary, gated by the member's scopes):
//   balances:<uid>  -> "update" | "payment_update"   (needs `balance`)
//   fills:<uid>     -> "trade"                         (needs `history`)
//   orders:<uid>    -> "new_open_order"                (needs `history`)
//   positions:<uid> -> "updated_positions"            (needs `portfolio`)
//
// The socket speaks the Phoenix v2 wire protocol directly (a JSON array
// [join_ref, ref, topic, event, payload]); no phoenix client dependency.

import { config, type AppProfile } from "./config";
import { stxRequest, type StxResult } from "./stxClient";
import { type AccountLink } from "./stores";

export interface LiveEvent {
  kind: "balances" | "fills" | "orders" | "positions";
  event: string;
  payload: unknown;
  ts: number;
}

type Listener = (e: LiveEvent) => void;

interface Conn {
  userId: string;
  token: string;
  ws: WebSocket | null;
  listeners: Set<Listener>;
  heartbeat: ReturnType<typeof setInterval> | null;
  reconnect: ReturnType<typeof setTimeout> | null;
  ref: number;
  torn: boolean;
}

// One connection per STX member (user id), shared by all of that member's SSE
// subscribers across browser tabs.
const conns = new Map<string, Conn>();

const PREFIXES = ["balances", "fills", "orders", "positions"] as const;

function socketUrl(): string {
  const base = config.stxBaseUrl.replace(/^http/, "ws");
  return `${base}/socket/websocket?vsn=2.0.0`;
}

function topicsFor(uid: string): string[] {
  return PREFIXES.map((p) => `${p}:${uid}`);
}

function kindOf(topic: string): LiveEvent["kind"] | null {
  const pre = topic.split(":", 1)[0] ?? "";
  return (PREFIXES as readonly string[]).includes(pre) ? (pre as LiveEvent["kind"]) : null;
}

// Resolve the member's STX user id (the topic suffix). The balance endpoint
// returns it and needs only the `balance` scope; `GET /api/v1/me` 500s for OAuth.
async function resolveUserId(app: AppProfile, link: AccountLink): Promise<string | null> {
  const { status, body }: StxResult = await stxRequest(
    app,
    link,
    "GET",
    config.paths.balance,
    undefined,
    "Resolved member id for the live feed",
  );
  if (status < 200 || status >= 300) return null;
  const uid = (body as { balance?: { user_id?: unknown } })?.balance?.user_id;
  return typeof uid === "string" && uid !== "" ? uid : null;
}

function send(conn: Conn, topic: string, event: string, payload: unknown): void {
  if (!conn.ws || conn.ws.readyState !== 1) return;
  const ref = String(++conn.ref);
  // v2 frame: [join_ref, ref, topic, event, payload]. join_ref === ref on join.
  conn.ws.send(JSON.stringify([ref, ref, topic, event, payload]));
}

function connect(conn: Conn): void {
  // Bun's WebSocket accepts a `headers` option (not in the DOM lib types).
  const ws = new WebSocket(socketUrl(), {
    headers: { "x-stx-oauth-token": conn.token },
  } as unknown as string[]);
  conn.ws = ws;

  ws.addEventListener("open", () => {
    for (const t of topicsFor(conn.userId)) send(conn, t, "phx_join", {});
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
    // Skip protocol control frames (phx_reply/phx_error/phx_close).
    if (event.startsWith("phx_")) return;
    const kind = kindOf(topic);
    if (!kind) return;
    const e: LiveEvent = { kind, event, payload, ts: Date.now() };
    for (const l of conn.listeners) l(e);
  });

  const drop = () => {
    if (conn.heartbeat) {
      clearInterval(conn.heartbeat);
      conn.heartbeat = null;
    }
    conn.ws = null;
    // Reconnect while anyone is still listening (e.g. token rotated / STX blip).
    if (!conn.torn && conn.listeners.size > 0 && !conn.reconnect) {
      conn.reconnect = setTimeout(() => {
        conn.reconnect = null;
        if (!conn.torn && conn.listeners.size > 0) connect(conn);
      }, 2000);
    }
  };
  ws.addEventListener("close", drop);
  ws.addEventListener("error", () => {
    try {
      ws.close();
    } catch {
      /* already closing */
    }
  });
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
  conns.delete(conn.userId);
}

// Subscribe to a linked member's live STX events. Returns an unsubscribe fn.
// Resolves to null if the member's user id can't be determined (unlinked/expired).
export async function subscribe(
  app: AppProfile,
  link: AccountLink,
  listener: Listener,
): Promise<(() => void) | null> {
  const userId = await resolveUserId(app, link);
  if (!userId) return null;

  let conn = conns.get(userId);
  if (!conn) {
    conn = {
      userId,
      token: link.accessToken,
      ws: null,
      listeners: new Set(),
      heartbeat: null,
      reconnect: null,
      ref: 0,
      torn: false,
    };
    conns.set(userId, conn);
    connect(conn);
  } else {
    conn.token = link.accessToken; // freshest token for any reconnect
  }

  conn.listeners.add(listener);
  const c = conn;
  return () => {
    c.listeners.delete(listener);
    if (c.listeners.size === 0) teardown(c);
  };
}
