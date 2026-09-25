// Live member feed: the ISV backend keeps a live view of the member's STX
// account from the socket and relays it to the browser.
//
// Why a backend proxy: STX authenticates a socket with the `x-stx-oauth-token`
// HEADER on the WS handshake. A browser cannot set WS headers (and must never
// hold the token anyway), but this backend can. So it opens ONE authenticated
// socket per linked user and app and fans the view out to that user's browser
// tabs over SSE (see GET /api/stream).
//
// The view is the SDK's `ws.accountView()`: it joins the member's four account
// topics, seeds each from its join snapshot and applies every pushed update.
//
//   balances:<uid>  -> "balances" snapshot, then "update" | "payment_update"  (`balance.read`)
//   orders:<uid>    -> "all_orders" snapshot, then "new_open_order"          (`orders.read`)
//   fills:<uid>     -> "all_trades" snapshot, then "trade"                   (`orders.read`)
//   positions:<uid> -> "all_positions" snapshot, then "updated_positions"    (`portfolio.read`)
//
// Nothing here calls REST to keep the view current: a new SSE subscriber is
// seeded from the view's state, and each change is relayed with its payload and
// the updated part of the view. After a reconnect the SDK rejoins, the exchange
// sends every snapshot again and the view replaces itself; subscribers get a
// `resync` so the browser refreshes its REST history lists once.
//
// A grant without one of the scopes cannot join that topic. Such a grant (an app
// configured with fewer OAUTH_SCOPES) gets the same view fed by the topics it
// can join.
//
// The socket is the SDK's `STXWebSocket` on the member client. It reads the
// member's CURRENT token from the link store on every (re)connect, refreshing
// it first when near expiry, and refreshes once more if STX refuses the
// handshake. It reconnects with jittered backoff (1 s doubling to 30 s). When
// the grant is revoked it stops for good and `onEnd` fires.

import {
  AccountView,
  ReconnectPolicy,
  STXChannelException,
  type AccountChange,
  type AccountState,
  type ChannelMessage,
  type STXWebSocket,
} from "@stxapp/stx-typescript";
import type { AppProfile } from "./config";
import { safeBody, type ActivityDetail } from "./activityDetail";
import { sdkCalls } from "./sdkCall";
import { activityStore, linkStore } from "./stores";
import { memberClient } from "./stx";

export type LiveKind = "balances" | "fills" | "orders" | "positions";

// One change, as relayed to the browser: the exchange's event and payload, and
// the part of the view it touched, already updated (`balance`, `openOrders`,
// `fills` or `positions`), so the browser replaces rather than recomputes.
export interface LiveEvent {
  kind: LiveKind;
  event: string;
  snapshot: boolean;
  payload: unknown;
  state: Partial<AccountState>;
  ts: number;
}

export type LiveMessage = { type: "change"; change: LiveEvent } | { type: "resync"; state: AccountState; ts: number };

type Listener = (m: LiveMessage) => void;

interface Conn {
  ws: STXWebSocket;
  view: AccountView;
  listeners: Set<Listener>;
  enders: Set<() => void>;
  // The member topics joined, in join order (for the activity log).
  joined: LiveKind[];
  // True when the view came from one `ws.accountView()` call.
  whole: boolean;
  // Resolves true once the member id is known and the topics were joined.
  ready: Promise<boolean>;
}

// One connection per (app, ISV user), shared by all of that user's SSE
// subscribers across browser tabs.
const conns = new Map<string, Conn>();

const KINDS: readonly LiveKind[] = ["balances", "orders", "fills", "positions"];

// The scope each topic needs.
const TOPIC_SCOPE: Record<LiveKind, string> = {
  balances: "balance.read",
  orders: "orders.read",
  fills: "orders.read",
  positions: "portfolio.read",
};

const QUIET_LOGGER = { debug() {}, info() {}, warn() {}, error() {} };

// Reconnect pacing: 1 s doubling to a 30 s cap, jittered, so a fleet of feeds
// that lost STX together does not come back together.
const RECONNECT = new ReconnectPolicy({ initialBackoffMs: 1000, maxBackoffMs: 30_000 });

function keyOf(app: AppProfile, userId: string): string {
  return `${app.id}:${userId}`;
}

function kindOf(change: AccountChange): LiveKind {
  return change.kind === "balance" || change.kind === "payment" ? "balances" : change.kind;
}

// The part of the view one change touched.
function partOf(view: AccountView, kind: LiveKind): Partial<AccountState> {
  switch (kind) {
    case "balances":
      return { balance: view.balance };
    case "orders":
      return { openOrders: view.openOrders };
    case "fills":
      return { fills: view.fills };
    case "positions":
      return { positions: view.positions };
  }
}

function open(app: AppProfile, userId: string): Conn {
  const key = keyOf(app, userId);
  const listeners = new Set<Listener>();
  const enders = new Set<() => void>();
  const emit = (m: LiveMessage) => {
    for (const l of listeners) l(m);
  };
  // The member id (the topic suffix) comes from `GET /api/v1/me`, or from the
  // balance when the grant lacks `profile.read`.
  const stx = memberClient(app, userId, "Resolved member id for the live feed", (e) =>
    sdkCalls.wsUserId(e.operationId),
  );
  const onChange = (change: AccountChange) => {
    const kind = kindOf(change);
    emit({
      type: "change",
      change: {
        kind,
        event: change.event,
        snapshot: change.snapshot,
        payload: change.payload,
        state: partOf(change.view, kind),
        ts: Date.now(),
      },
    });
  };
  const ws = stx.websocket({
    logger: QUIET_LOGGER,
    reconnectPolicy: RECONNECT,
    // Rejoined after a drop: the snapshots re-seed the view on their own; the
    // browser refreshes its REST history once.
    onReconnect: () => emit({ type: "resync", state: conn.view.state(), ts: Date.now() }),
    // The grant is gone (revoked, or the refresh was refused): the SDK already
    // deleted the link. End every subscriber's stream; the UI shows unlinked.
    onAuthError: () => {
      conns.delete(key);
      for (const end of enders) end();
    },
  });
  const conn: Conn = {
    ws,
    view: new AccountView(ws, { onChange }),
    listeners,
    enders,
    joined: [],
    whole: false,
    ready: Promise.resolve(false),
  };
  conn.ready = (async () => {
    try {
      await ws.userId();
    } catch {
      return false;
    }
    const scopes = new Set(linkStore.get(userId)?.scopes ?? []);
    if (KINDS.every((k) => scopes.has(TOPIC_SCOPE[k]))) {
      try {
        conn.view = await ws.accountView({ onChange });
        conn.whole = true;
        conn.joined.push(...KINDS);
        return true;
      } catch (err) {
        // A topic refused after all (scopes changed at STX): join what we can.
        if (!(err instanceof STXChannelException)) throw err;
        conn.view = new AccountView(ws, { onChange });
      }
    }
    // A narrower grant: the same view, fed by the topics it may join.
    const apply = (m: ChannelMessage) => {
      conn.view.apply(m);
    };
    for (const kind of KINDS) {
      try {
        await ws[kind]({ onMessage: apply });
        conn.joined.push(kind);
      } catch (err) {
        // A grant without a topic's scope is refused per topic; the others
        // still stream. Anything else (socket down) is retried by the SDK.
        if (!(err instanceof STXChannelException)) throw err;
      }
    }
    return true;
  })().catch(() => false);
  return conn;
}

function teardown(key: string, conn: Conn): void {
  if (conns.get(key) === conn) conns.delete(key);
  void conn.ws.close();
}

// Subscribe to a linked user's live STX account. The listener gets a `resync`
// with the whole current view first (the SSE seed), then every change.
// Returns an unsubscribe fn, or null if the feed could not start (member id
// unknown: unlinked or expired). `onEnd` fires if STX ends the feed for good
// (the grant was revoked).
export async function subscribe(
  app: AppProfile,
  userId: string,
  listener: Listener,
  onEnd: () => void,
): Promise<(() => void) | null> {
  const key = keyOf(app, userId);
  let conn = conns.get(key);
  const opened = !conn;
  if (!conn) {
    conn = open(app, userId);
    conns.set(key, conn);
  }
  const c = conn;
  c.enders.add(onEnd);
  const unsubscribe = () => {
    c.listeners.delete(listener);
    c.enders.delete(onEnd);
    if (c.listeners.size === 0) teardown(key, c);
  };
  // Held until the view is seeded, so the seed below is the whole state and no
  // change arrives before it.
  const ok = await c.ready;
  if (opened) {
    // One row per opened feed, with the SDK calls it made.
    activityStore.record({
      ts: Date.now(),
      appId: app.id,
      method: "WS",
      path: "/socket (portfolio)",
      status: null,
      note: ok ? "Opened live feed" : "Live feed failed to open",
      sdkCall: c.whole ? sdkCalls.accountView() : sdkCalls.memberJoins(c.joined),
      userId,
      detail: feedDetail(c, ok),
    });
  }
  if (!ok) {
    if (c.listeners.size === 0) teardown(key, c);
    c.enders.delete(onEnd);
    return null;
  }
  listener({ type: "resync", state: c.view.state(), ts: Date.now() });
  c.listeners.add(listener);
  return unsubscribe;
}

// The member's STX balance from an open live feed, or undefined when there is
// none yet. Lets GET /api/wallet answer without a REST balance call.
export function liveBalance(app: AppProfile, userId: string): Record<string, unknown> | undefined {
  const conn = conns.get(keyOf(app, userId));
  return conn?.view.balance ?? undefined;
}

// Close a user's feed now (unlink, sign-out): nothing should keep streaming on
// a grant that was just revoked.
export async function closeLiveFeed(app: AppProfile, userId: string): Promise<void> {
  const key = keyOf(app, userId);
  const conn = conns.get(key);
  if (!conn) return;
  conns.delete(key);
  for (const end of conn.enders) end();
  await conn.ws.close();
}

// The joins a feed made and what their snapshots seeded, for the activity row.
function feedDetail(c: Conn, ok: boolean): ActivityDetail {
  const state = c.view.state() as unknown as Record<string, unknown>;
  const count = (v: unknown) => (Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0);
  const summary = ok
    ? `joined ${c.joined.join(", ") || "nothing"}; snapshot: ${count(state.openOrders)} open orders, ` +
      `${count(state.fills)} fills, ${count(state.positions)} positions`
    : "feed did not open (member id unknown or every join refused)";
  return {
    request: {
      method: "JOIN",
      path: "member topics (OAuth member token)",
      ...safeBody({ topics: KINDS.map((k) => `${k}:<member id>`) }),
    },
    response: { status: null, summary, ...(ok ? safeBody(state) : {}) },
  };
}
