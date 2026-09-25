// The activity log records, for every row, the @stxapp/stx-typescript call that
// produced it (activity.sdk_call). These tests drive the real SDK paths: a REST
// member call, an automatic token refresh with its retry, the socket joins of
// the live member feed and of a public market feed.
//
// No live server: `fetch` is scripted, and the SDK's `ws` socket is replaced by
// a fake Phoenix server that accepts every join. The env block matches the
// other test files (the `config` singleton is shared across files).

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

process.env.STX_BASE_URL = "https://stx.example.com";
process.env.CLIENT_ID = "sideline-test-client-id";
process.env.CLIENT_SECRET = "sideline-test-client-secret";
process.env.REDIRECT_URI = "http://localhost:8787/callback";
process.env.OAUTH_SCOPES = "profile.read balance.read portfolio.read orders.read orders.write";
process.env.DB_PATH = ":memory:";

// A fake `ws` WebSocket speaking just enough Phoenix v2: it opens at once,
// answers every frame (join, leave, heartbeat) with an ok reply, and after an
// account-topic join pushes that topic's snapshot, as STX does.
const joinedTopics: string[] = [];
const SNAPSHOTS: Record<string, [string, unknown]> = {
  balances: ["balances", { available_balance: "12.3400", buy_order_liability: "0.0000" }],
  orders: ["all_orders", { orders: [] }],
  fills: ["all_trades", { trades: [] }],
  positions: ["all_positions", { positions: [] }],
};
// The `market:<id>` join reply: the whole market, with its event status.
const MARKET_REPLY = (topic: string) => ({
  market_id: topic.slice("market:".length),
  event_id: "e-1",
  price: 50,
  event_brief: "CHC 3 - 4 BOS : Bottom 8th 1 Outs",
  detailed_event_brief: "CHC 3 - 4 BOS : Bottom 8th 1 Outs",
  event_status: "in_progress",
  status: "open",
  ob: { b: [], o: [] },
});
const sockets: FakeSocket[] = [];
class FakeSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 0;
  constructor(readonly url: string) {
    super();
    sockets.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.emit("open");
    }, 0);
  }
  send(raw: string): void {
    const [joinRef, ref, topic, event] = JSON.parse(raw) as [string, string, string, string];
    if (event === "phx_join") joinedTopics.push(topic);
    const response = event === "phx_join" && topic.startsWith("market:") ? MARKET_REPLY(topic) : {};
    const reply = [joinRef, ref, topic, "phx_reply", { status: "ok", response }];
    setTimeout(() => this.emit("message", JSON.stringify(reply)), 0);
    const snapshot = event === "phx_join" ? SNAPSHOTS[topic.split(":")[0]!] : undefined;
    if (snapshot) setTimeout(() => this.push(topic, snapshot[0], snapshot[1], joinRef), 1);
  }
  // A server push on a joined topic.
  push(topic: string, event: string, payload: unknown, joinRef: string | null = null): void {
    this.emit("message", JSON.stringify([joinRef, null, topic, event, payload]));
  }
  terminate(): void {
    this.readyState = 3;
    this.emit("close");
  }
  close(): void {
    this.terminate();
  }
}
mock.module("ws", () => ({ default: FakeSocket, WebSocket: FakeSocket }));

const { config } = await import("./config");
const { db } = await import("./db");
const { activityStore, linkStore, userStore } = await import("./stores");
const { memberClient } = await import("./stx");
const { sdkCalls, shortId } = await import("./sdkCall");
const { subscribe } = await import("./liveProxy");
const { briefFrom, subscribeMarket } = await import("./marketProxy");

const sideline = config.app;

const realFetch = globalThis.fetch;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
}

function bearer(init?: RequestInit): string | null {
  return new Headers(init?.headers).get("authorization");
}

function linkedUser(access: string, expiresAt: number | null = null): string {
  const uid = userStore.ensure({ sessionId: `s-${crypto.randomUUID()}`, appId: "sideline", name: "A", startingWalletCents: 1 }).id;
  linkStore.save({
    userId: uid,
    appId: "sideline",
    accessToken: access,
    refreshToken: "stx_rt_old",
    accessExpiresAt: expiresAt,
    scopes: ["profile.read", "balance.read", "orders.read", "portfolio.read"],
  });
  return uid;
}

// Oldest first, as the panel reads bottom-up.
function rows() {
  return activityStore.list(50, "sideline").reverse();
}

beforeEach(() => {
  joinedTopics.length = 0;
  db.exec("DELETE FROM users; DELETE FROM account_links; DELETE FROM auth_flows; DELETE FROM activity;");
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("sdk_call on REST rows", () => {
  test("a member REST call records the SDK call with its real arguments", async () => {
    const uid = linkedUser("stx_at_ok", Date.now() + 3600_000);
    mockFetch(() => json(200, { order: { order_id: "o-1" } }));
    const order = { marketId: "3f9c2a1b-7d44-4c0e-9a51-0e2b8f6c1d99", action: "buy", orderType: "limit", price: "0.01", quantity: "1" };
    const { marketId, action, orderType, ...opts } = order;
    await memberClient(sideline, uid, "Placed an order", sdkCalls.placeOrder(order)).placeOrder(
      marketId,
      action,
      orderType,
      opts,
    );

    const [row] = rows();
    expect([row!.method, row!.path, row!.status, row!.note]).toEqual(["POST", "/api/v1/orders", 200, "Placed an order"]);
    expect(row!.sdkCall).toBe('stx.placeOrder("3f9c2a1b…", "buy", "limit", { price: "0.01", quantity: "1" })');
  });

  test("a 401 refresh is logged as the automatic SDK refresh; the retry keeps the call and says so", async () => {
    const uid = linkedUser("stx_at_old");
    mockFetch((url, init) => {
      if (url.endsWith("/oauth/token")) {
        return json(200, { access_token: "stx_at_new", refresh_token: "stx_rt_new", expires_in: 3600 });
      }
      return bearer(init) === "Bearer stx_at_new"
        ? json(200, { balance: { user_id: "stx-uid" } })
        : json(401, { error: "invalid_token" });
    });

    await memberClient(sideline, uid, "Checked STX balance", sdkCalls.balance()).balance();

    expect(rows().map((r) => [r.path, r.status, r.note, r.sdkCall])).toEqual([
      ["/api/v1/account/balance", 401, "Checked STX balance", "stx.balance()"],
      ["/oauth/token", 200, "refreshed access token", "session.refresh(refreshToken) // automatic (SDK single-flight refresh)"],
      ["/api/v1/account/balance", 200, "Checked STX balance (retry after token refresh)", "stx.balance()"],
    ]);
  });

  test("rows written without an SDK call (older rows) read back as null", () => {
    activityStore.record({ ts: 1, appId: "sideline", method: "GET", path: "/x", status: 200, note: null });
    expect(rows()[0]!.sdkCall).toBeNull();
  });
});

describe("sdk_call on socket rows", () => {
  test("the live feed is one accountView: member id lookup, then the view, no balance call", async () => {
    const uid = linkedUser("stx_at_ok", Date.now() + 3600_000);
    mockFetch(() => json(200, { me: { user_id: "stx-member-1" } }));

    const unsub = await subscribe(sideline, uid, () => {}, () => {});
    expect(unsub).not.toBeNull();
    unsub!();

    expect(joinedTopics).toEqual([
      "balances:stx-member-1",
      "orders:stx-member-1",
      "fills:stx-member-1",
      "positions:stx-member-1",
    ]);
    expect(rows().map((r) => [r.method, r.path, r.note, r.sdkCall])).toEqual([
      ["GET", "/api/v1/me", "Resolved member id for the live feed", "await ws.userId() // stx.me()"],
      [
        "WS",
        "/socket (portfolio)",
        "Opened live feed",
        "const ws = stx.websocket({ onReconnect }); const view = await ws.accountView({ onChange })",
      ],
    ]);
  });

  test("a grant without every account scope joins the topics it has", async () => {
    const uid = linkedUser("stx_at_ok", Date.now() + 3600_000);
    linkStore.save({ ...linkStore.get(uid)!, scopes: ["profile.read", "balance.read", "orders.write"] });
    mockFetch(() => json(200, { me: { user_id: "stx-member-2" } }));

    const unsub = await subscribe(sideline, uid, () => {}, () => {});
    unsub!();

    const ws = rows().find((r) => r.method === "WS")!;
    expect(ws.sdkCall).toBe(
      "const ws = stx.websocket(); await ws.balances({ onMessage }); await ws.orders({ onMessage }); " +
        "await ws.fills({ onMessage }); await ws.positions({ onMessage })",
    );
  });

  test("a market feed logs the public channel join on the app-token socket", async () => {
    mockFetch((url) =>
      url.endsWith("/oauth/token") ? json(200, { access_token: "stx_at_app", expires_in: 3600 }) : json(404, {}),
    );
    const marketId = "9e1d7c3a-0000-4000-8000-000000000001";
    const unsub = subscribeMarket(sideline, { topic: "orderbook", marketIds: [marketId] }, () => {});
    await new Promise((r) => setTimeout(r, 50));
    unsub();

    expect(joinedTopics.some((t) => t.startsWith("orderbook"))).toBe(true);
    const ws = rows().find((r) => r.method === "WS")!;
    expect([ws.path, ws.note]).toEqual(["/socket (orderbook)", "Opened market feed"]);
    expect(ws.sdkCall).toBe(`oauth.appClient("market_data").websocket().orderbook(["${shortId(marketId)}"], { onMessage })`);
  });
});

describe("live relay", () => {
  test("a subscriber is seeded from the view, then gets each change with the updated part; no REST per event", async () => {
    const uid = linkedUser("stx_at_ok", Date.now() + 3600_000);
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(new URL(url).pathname);
      return json(200, { me: { user_id: "stx-member-3" } });
    });
    const { liveBalance } = await import("./liveProxy");
    const got: any[] = [];
    const unsub = await subscribe(sideline, uid, (m) => got.push(m), () => {});

    expect(got[0].type).toBe("resync");
    expect(got[0].state.balance.available_balance).toBe("12.3400");
    expect(liveBalance(sideline, uid)?.available_balance).toBe("12.3400");

    const ws = sockets.at(-1)!;
    const order = { id: "o-1", market_id: "m-1", status: "open", price: "0.0100", inserted_at: 1 };
    ws.push("orders:stx-member-3", "new_open_order", order);
    ws.push("balances:stx-member-3", "update", { available_balance: "12.3300", buy_order_liability: "0.0100" });
    ws.push("orders:stx-member-3", "new_open_order", { ...order, status: "cancelled" });
    await new Promise((r) => setTimeout(r, 20));

    const changes = got.slice(1).map((m) => m.change);
    expect(changes.map((c) => [c.kind, c.event, c.snapshot])).toEqual([
      ["orders", "new_open_order", false],
      ["balances", "update", false],
      ["orders", "new_open_order", false],
    ]);
    expect(changes[0].state.openOrders.map((o: any) => o.id)).toEqual(["o-1"]);
    expect(changes[1].state.balance.available_balance).toBe("12.3300");
    expect(changes[2].state.openOrders).toEqual([]);
    expect(liveBalance(sideline, uid)?.available_balance).toBe("12.3300");
    // Only the member id lookup went over REST.
    expect(calls).toEqual(["/api/v1/me"]);
    unsub!();
  });
});

describe("live event status (market:<id>)", () => {
  test("briefFrom keeps only the event status, merging a diff over what was known", () => {
    const first = briefFrom(undefined, "m1", MARKET_REPLY("market:m1"));
    expect(first).toEqual({
      market_id: "m1",
      event_id: "e-1",
      event_brief: "CHC 3 - 4 BOS : Bottom 8th 1 Outs",
      detailed_event_brief: "CHC 3 - 4 BOS : Bottom 8th 1 Outs",
      event_status: "in_progress",
      status: "open",
    });
    // A diff that moves only the price is not a brief change.
    expect(briefFrom(first!, "m1", { market_id: "m1", last_traded_price: "0.6100" })).toBeNull();
    const next = briefFrom(first!, "m1", { market_id: "m1", event_brief: "CHC 3 - 5 BOS : Bottom 8th 2 Outs" });
    expect(next?.event_brief).toBe("CHC 3 - 5 BOS : Bottom 8th 2 Outs");
    expect(next?.event_status).toBe("in_progress");
  });

  test("the market topic joins market:<id> per market and relays each join's brief", async () => {
    const events: { event: string; payload: any }[] = [];
    const unsub = subscribeMarket(sideline, { topic: "market", marketIds: ["m1", "m2", "m1"] }, (e) =>
      events.push({ event: e.event, payload: e.payload }),
    );
    for (let i = 0; i < 50 && !events.some((e) => e.event === "joined"); i++) await Bun.sleep(10);
    unsub();
    expect(joinedTopics.filter((t) => t.startsWith("market:"))).toEqual(["market:m1", "market:m2"]);
    const briefs = events.filter((e) => e.event === "brief").map((e) => [e.payload.market_id, e.payload.event_brief]);
    expect(briefs).toEqual([
      ["m1", "CHC 3 - 4 BOS : Bottom 8th 1 Outs"],
      ["m2", "CHC 3 - 4 BOS : Bottom 8th 1 Outs"],
    ]);
    const [row] = rows();
    expect(row!.path).toBe("/socket (market)");
    expect(row!.note).toBe("Opened live scores for 2 markets");
    expect(row!.sdkCall).toBe(
      'oauth.appClient("market_data").websocket().market("m1", { onMessage })\n' +
        'oauth.appClient("market_data").websocket().market("m2", { onMessage })',
    );
  });
});
