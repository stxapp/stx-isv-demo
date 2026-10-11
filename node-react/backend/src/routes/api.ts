// Routes the frontend calls. Three groups:
//   - app + session state: /app, /me, /signout (signing in is per login mode,
//     see ../login/)
//   - account linking side-effects: /unlink (linking itself is in ../login/)
//   - authenticated STX proxies: /wallet, /balance, /orders, /activity
//
// Each STX proxy resolves the app, the signed-in user, and
// that user's STX link, then calls STX through the SDK's member client, which
// attaches the member's bearer token server-side and refreshes it. The browser
// sees JSON, never a token. STX's bodies are re-wrapped in the envelope STX
// sent (`{balance}`, `{orders, cursor}`, ...) so the frontend sees the same
// JSON as before; an STX error is forwarded with STX's own status and body.

import { Hono, type Context } from "hono";
import type { NewOrderInput, STX } from "@stxapp/stx-typescript";
import { STXAccountPendingException, STXGrantRevokedException } from "@stxapp/stx-typescript/oauth";
import { buildDetail } from "../activityDetail";
import { config, type AppProfile } from "../config";
import { appFromRequest, centsToDollarString, extractStxCashCents, publicUser } from "../helpers";
import { clearSession, getSession } from "../session";
import { publicLogin, signOutUrl } from "../login";
import { activityStore, linkStore, userStore, type AccountLink, type User } from "../stores";
import { MARKET_DATA_SCOPE, memberClient, NotLinkedError, stxApp, stxErrorResponse, type SdkCall } from "../stx";
import { sdkCalls } from "../sdkCall";
import { streamSSE } from "hono/streaming";
import { closeLiveFeed, liveBalance, subscribe, type LiveMessage } from "../liveProxy";
import { CATALOG_QUERY, catalogCacheFor, fetchRecentTrades } from "../marketCatalog";
import { MARKET_TOPICS, subscribeMarket, type MarketTopic } from "../marketProxy";

export const apiRoutes = new Hono();

// Run one SDK call for a proxy route and answer with its result. An STX error
// is forwarded with STX's status and body, as the proxies always did. A grant
// STX refused to refresh is already unlinked by the SDK (the link row is
// deleted), so it answers like any other missing link.
async function forward(c: Context, call: () => Promise<unknown>): Promise<Response> {
  try {
    return c.json((await call()) as object);
  } catch (err) {
    // The member's STX account is still being verified: the link is kept (the
    // SDK keeps the tokens), and calls work once STX finishes.
    if (err instanceof STXAccountPendingException) {
      return c.json({ error: "account_pending", message: "Your STX account is still being set up. Finish at STX, then try again." }, 409);
    }
    if (err instanceof STXGrantRevokedException) {
      throw new NotLinkedError("Your STX link was revoked. Link your STX account again.");
    }
    const stx = stxErrorResponse(err);
    if (stx) return c.json(stx.body as object, stx.status as never);
    throw err;
  }
}

// The SDK member client for the signed-in, linked user of the active app.
// `label` and `sdkCall` (the @stxapp/stx-typescript call, as code) go on the activity
// rows the client writes.
function requireMember(c: Context, label: string, sdkCall: SdkCall): { app: AppProfile; user: User; stx: STX } {
  const app = requireApp(c);
  const user = requireUser(c, app);
  requireLink(user);
  return { app, user, stx: memberClient(app, user.id, label, sdkCall) };
}

// Public-safe view of an app profile (no secrets).
function publicApp(app: AppProfile) {
  return {
    id: app.id,
    name: app.name,
    tagline: app.tagline,
    brandColor: app.brandColor,
    scopes: app.scopes.split(" ").filter(Boolean),
  };
}

// Resolve the active app or throw a 400. A bare app id that is not configured
// is a client error, distinct from "not linked".
function requireApp(c: Context): AppProfile {
  const app = appFromRequest(c);
  if (!app) throw new UnknownAppError(c.req.query("app") ?? "");
  return app;
}

// Resolve the signed-in user for (session, app), or throw NotLinkedError.
function requireUser(c: Context, app: AppProfile): User {
  const sid = getSession(c);
  const user = sid ? userStore.find(sid, app.id) : null;
  if (!user) throw new NotLinkedError(`Not signed in to ${app.name}.`);
  return user;
}

// Resolve the user's STX link, or throw NotLinkedError.
function requireLink(user: User): AccountLink {
  const link = linkStore.get(user.id);
  if (!link) throw new NotLinkedError();
  return link;
}

// GET /api/app: the app's public profile, and where the exchange lives for the
// browser (the deposit popup and the exchange-served sport icons). Read at
// runtime, so moving either host is a config change with no frontend rebuild.
// `gaMeasurementId` is the optional Google Analytics 4 id (null: analytics off);
// the other `ga*` fields are its optional settings (empty lists by default).
apiRoutes.get("/app", (c) => {
  return c.json({
    app: publicApp(config.app),
    stxPublicUrl: config.stxPublicUrl,
    gaMeasurementId: config.gaMeasurementId,
    gaIgnoreReferrerDomains: config.gaIgnoreReferrerDomains,
    gaLinkedDomains: config.gaLinkedDomains,
    gaConsentRequiredRegions: config.gaConsentRequiredRegions,
    // How people get into this deployment (LOGIN_MODE), for the sign-in UI.
    login: publicLogin(),
  });
});

// POST /api/signout?app=<id>: sign out of the app on this browser.
// - A user with an account behind them (every login but the mock one) is only
//   detached from the session: the user, their wallet and their STX link stay
//   for the next sign-in.
// - A mock-login user has nothing to come back to, so they are removed
//   entirely: the STX link is revoked and dropped, the user and wallet deleted.
// `signOutUrl` is where the browser should go next so the login behind the app
// signs out too (`vendor` mode), or null.
apiRoutes.post("/signout", async (c) => {
  const app = requireApp(c);
  const sid = getSession(c);
  if (sid) {
    const user = userStore.find(sid, app.id);
    if (user?.externalId) {
      userStore.detachSession(sid, app.id);
      // Nothing keeps streaming their account to a browser they signed out of.
      await closeLiveFeed(app, user.id);
    } else if (user) {
      await revokeAndDropLink(app, user);
      userStore.remove(sid, app.id);
    }
    // The session id is finished with: the next visit starts a new one.
    clearSession(c);
  }
  return c.json({ ok: true, signOutUrl: await signOutUrl() });
});

// POST /api/unlink?app=<id>: unlink the STX account: best-effort revoke at STX
// and drop the local link. Keeps the ISV user + wallet, so they can relink.
apiRoutes.post("/unlink", async (c) => {
  const app = requireApp(c);
  const user = requireUser(c, app);
  await revokeAndDropLink(app, user);
  return c.json({ ok: true });
});

// GET /api/me?app=<id>: everything the frontend needs to render the active
// app: the app profile, the signed-in user (+ wallet), and the STX link status.
//
// `?verify=1` proves a stored link still works before answering: one real STX
// call through the SDK (the balance), which refreshes the token when needed. A
// grant revoked at STX fails the refresh (`invalid_grant`) and the SDK drops
// the link, so the answer is "not linked" and the UI offers to link again. A
// transport error or an STX outage leaves the link as it is.
apiRoutes.get("/me", async (c) => {
  const app = requireApp(c);
  const sid = getSession(c);
  const user = sid ? userStore.find(sid, app.id) : null;
  if (user && linkStore.get(user.id) && c.req.query("verify")) await verifyLink(app, user);
  const link = user ? linkStore.get(user.id) : null;
  return c.json({
    app: publicApp(app),
    user: user ? publicUser(user) : null,
    link: link
      ? { connected: true, scopes: link.scopes, linkedAt: link.linkedAt }
      : { connected: false, scopes: [], linkedAt: null },
  });
});

// Demo top-ups for the app's own wallet: whole dollars, one at a time up to
// $1,000, and the wallet never above $100,000. No payment is taken.
const MAX_TOPUP_CENTS = 100_000;
const MAX_WALLET_CENTS = 10_000_000;

// POST /api/wallet/deposit?app=<id>: add demo funds to the app's OWN wallet.
// Body: { cents }. This is the ISV's money only; STX funds are added at STX.
apiRoutes.post("/wallet/deposit", async (c) => {
  const app = requireApp(c);
  const user = requireUser(c, app);
  const body = (await c.req.json().catch(() => ({}))) as { cents?: unknown };
  const cents = body.cents;
  if (typeof cents !== "number" || !Number.isInteger(cents) || cents <= 0 || cents % 100 !== 0 || cents > MAX_TOPUP_CENTS) {
    return c.json({ error: "invalid_amount", message: "Choose a whole-dollar amount from $1 to $1,000." }, 400);
  }
  if (user.walletCents + cents > MAX_WALLET_CENTS) {
    return c.json({ error: "wallet_limit", message: "The demo wallet tops out at $100,000." }, 400);
  }
  const updated = userStore.addFunds(user.id, cents);
  return c.json({ user: updated ? publicUser(updated) : null });
});

// GET /api/wallet?app=<id>: the dual-wallet view: the ISV app's OWN wallet
// (authoritative, held here) alongside the STX cash balance (fetched live from
// STX via the link, scope `balance.read`). Combined total is shown only when the STX
// cash amount can be parsed confidently: otherwise the raw STX body is
// returned and the frontend omits the total rather than inventing one.
apiRoutes.get("/wallet", async (c) => {
  const app = requireApp(c);
  const user = requireUser(c, app);

  const appWallet = {
    label: `${app.name} Wallet`,
    walletCents: user.walletCents,
    walletDollars: centsToDollarString(user.walletCents),
    heldBy: app.name,
  };

  const link = linkStore.get(user.id);
  if (!link) {
    return c.json({
      app: app.id,
      isv: appWallet,
      stx: { linked: false, balance: null, cashCents: null },
      combinedCents: null,
    });
  }

  // STX's status and body: 200 with `{balance}`, or the error STX answered.
  // With the member's live feed open, the balance is the one the socket keeps
  // (no STX call). `?stx=live` says the browser holds the live feed itself: if
  // the feed has no balance yet, answer without one rather than call STX.
  let status = 200;
  let body: unknown;
  const live = liveBalance(app, user.id);
  if (live || c.req.query("stx") === "live") {
    const cashCents = live ? extractStxCashCents({ balance: live }) : null;
    return c.json({
      app: app.id,
      isv: appWallet,
      stx: {
        linked: true,
        heldBy: "STX",
        status: live ? 200 : undefined,
        source: "live",
        balance: live ? { balance: live } : null,
        cashCents,
        cashDollars: cashCents !== null ? centsToDollarString(cashCents) : null,
      },
      combinedCents: cashCents !== null ? user.walletCents + cashCents : null,
      combinedDollars: cashCents !== null ? centsToDollarString(user.walletCents + cashCents) : null,
    });
  }
  try {
    body = { balance: await memberClient(app, user.id, "Checked STX balance", sdkCalls.balance()).balance() };
  } catch (err) {
    if (err instanceof STXGrantRevokedException) {
      // The SDK dropped the dead link: show the wallet as not linked.
      return c.json({
        app: app.id,
        isv: appWallet,
        stx: { linked: false, balance: null, cashCents: null },
        combinedCents: null,
      });
    }
    const stx = stxErrorResponse(err);
    if (!stx) throw err;
    ({ status, body } = stx);
  }
  const cashCents = status >= 200 && status < 300 ? extractStxCashCents(body) : null;
  return c.json({
    app: app.id,
    isv: appWallet,
    stx: {
      linked: true,
      heldBy: "STX",
      status,
      balance: body, // raw STX body, rendered as-is by the frontend
      cashCents,
      cashDollars: cashCents !== null ? centsToDollarString(cashCents) : null,
    },
    combinedCents: cashCents !== null ? user.walletCents + cashCents : null,
    combinedDollars:
      cashCents !== null ? centsToDollarString(user.walletCents + cashCents) : null,
  });
});

// GET /api/balance?app=<id> -> raw STX balance/identity endpoint.
apiRoutes.get("/balance", async (c) => {
  const { stx } = requireMember(c, "Checked STX balance", sdkCalls.balance());
  return forward(c, async () => ({ balance: await stx.balance() }));
});

// Map the demo's flat betslip order to the SDK's order input. The betslip
// carries price in CENTS (integers, e.g. 44); STX wants a DOLLAR STRING
// (`"0.44"`), lower-case enums and a string quantity, with price omitted for
// market orders. The SDK sends it as the body of `POST /api/v1/orders` (single)
// or one leg of `POST /api/v1/orders/batched`.
function toOrderInput(b: Record<string, unknown>): NewOrderInput {
  const orderType = String(b.order_type || "limit").toLowerCase();
  const order: NewOrderInput = {
    marketId: String(b.market_id ?? ""),
    orderType,
    action: String(b.action || "buy").toLowerCase(),
    quantity: String(b.quantity ?? ""),
  };
  if (orderType === "limit" && b.price !== undefined && String(b.price).trim() !== "") {
    order.price = (Math.round(Number(b.price)) / 100).toFixed(2);
  }
  return order;
}

// An order the SDK refuses before sending (no market, empty quantity) is a 400
// with `{error}`, like STX's own validation answer.
function badOrder(c: Context, err: unknown): Response | null {
  return err instanceof TypeError ? c.json({ error: err.message }, 400) : null;
}

// GET /api/orders?app=<id> -> list the member's orders.
apiRoutes.get("/orders", async (c) => {
  const { stx } = requireMember(c, "Loaded order history", sdkCalls.orders());
  return forward(c, async () => {
    const page = await stx.orders();
    return { orders: page.items, cursor: page.cursor };
  });
});

// POST /api/orders?app=<id> -> place an order via REST `POST /api/v1/orders`.
// The OAuth bearer carries the member's `orders.write` scope; STX returns the
// order on placement, 422 with `{ error }` on rejection, forwarded as-is.
apiRoutes.post("/orders", async (c) => {
  const payload = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const order = toOrderInput(payload);
  const { stx } = requireMember(c, "Placed an order", sdkCalls.placeOrder(order));
  const { marketId, action, orderType, ...opts } = order;
  try {
    return await forward(c, async () => ({ order: await stx.placeOrder(marketId, action, orderType, opts) }));
  } catch (err) {
    const res = badOrder(c, err);
    if (res) return res;
    throw err;
  }
});

// POST /api/orders/batch?app=<id> -> place several orders via REST
// `POST /api/v1/orders/batched`. Body: { orders: [ <flat order>, ... ] }. STX
// returns 200 with a per-leg `results` array (`{order}` | `{errors}`); a
// malformed body is a 400 that places nothing. Forwarded as-is.
apiRoutes.post("/orders/batch", async (c) => {
  const payload = (await c.req.json().catch(() => ({}))) as { orders?: unknown };
  const list = Array.isArray(payload.orders) ? payload.orders : [];
  if (list.length === 0) return c.json({ error: "No orders in the batch." }, 400);
  const orders = list.map((o) => toOrderInput(o as Record<string, unknown>));
  const { stx } = requireMember(c, "Placed a batch of orders", sdkCalls.placeOrders(orders));
  try {
    return await forward(c, async () => {
      // The SDK adds `ok` and null placeholders to each leg; send STX's own leg.
      const results = (await stx.placeOrders(orders)).map(({ ok: _ok, ...leg }) => {
        if (leg.order === null) delete leg.order;
        if (leg.errors === null) delete leg.errors;
        return leg;
      });
      return { results };
    });
  } catch (err) {
    const res = badOrder(c, err);
    if (res) return res;
    throw err;
  }
});

// DELETE /api/orders/:id?app=<id> -> cancel an order via REST
// `DELETE /api/v1/orders/:id` (covered by the `orders.write` scope). STX returns the
// cancelled order on 200, or 404/422 with `{ error }`; forwarded as-is.
apiRoutes.delete("/orders/:id", async (c) => {
  const id = c.req.param("id");
  const { stx } = requireMember(c, "Cancelled an order", sdkCalls.cancelOrder(id));
  // The cancel route has no envelope: the SDK returns STX's body whole.
  return forward(c, () => stx.cancelOrder(id));
});

// GET /api/trades?app=<id> -> the member's fills (scope `orders.read`).
apiRoutes.get("/trades", async (c) => {
  const { stx } = requireMember(c, "Loaded trades", sdkCalls.fills());
  return forward(c, async () => {
    const page = await stx.fills();
    return { fills: page.items, cursor: page.cursor };
  });
});

// GET /api/settlements?app=<id> -> the member's settled positions (scope
// `portfolio.read`) via REST `GET /api/v1/portfolio/settlements`, in STX's
// snake_case with dollar-string money (the shape the activity UI reads),
// normalising only the timestamp key the UI expects (`settled_at`). A non-2xx
// (e.g. a scope or auth error) passes STX's body through.
apiRoutes.get("/settlements", async (c) => {
  const { stx } = requireMember(c, "Loaded settlements", sdkCalls.settlements());
  return forward(c, async () => {
    const page = await stx.settlements();
    const settlements = (page.items as unknown as Record<string, unknown>[]).map((s) => ({
      ...s,
      settled_at: s.settled_at ?? s.inserted_at ?? s.inserted_at_iso,
    }));
    return { settlements, cursor: page.cursor };
  });
});

// GET /api/stream?app=<id> -> Server-Sent Events of the member's LIVE STX
// account (balance, open orders, fills, positions). The ISV backend holds the
// authenticated STX socket and its `ws.accountView()` (the token never reaches
// the browser); this same-origin SSE relays it. The browser opens it with
// EventSource.
//
//   state     the whole view, first on every (re)connect of this stream, and
//             again after the STX socket reconnects (`data.resync` true then):
//             the browser replaces its live state and refreshes REST history once
//   balances | orders | fills | positions
//             one change: `{kind, event, snapshot, payload, state, ts}` where
//             `state` is the updated part of the view
//   ready     the feed is open; `error` with `relink_required` when the grant died
apiRoutes.get("/stream", (c) => {
  const app = requireApp(c);
  const user = requireUser(c, app);
  requireLink(user);
  // liveProxy.subscribe logs the "Opened live feed" row when it opens the socket.
  return streamSSE(c, async (stream) => {
    let unsub: (() => void) | null = null;
    // Set when STX ends the feed for good (the grant was revoked).
    let ended = false;
    let seeded = false;
    stream.onAbort(() => unsub?.());

    unsub = await subscribe(
      app,
      user.id,
      (m: LiveMessage) => {
        if (m.type === "resync") {
          const data = { ...m.state, resync: seeded, ts: m.ts };
          seeded = true;
          stream.writeSSE({ event: "state", data: JSON.stringify(data) }).catch(() => {});
        } else {
          stream.writeSSE({ event: m.change.kind, data: JSON.stringify(m.change) }).catch(() => {});
        }
      },
      () => {
        ended = true;
        stream.writeSSE({ event: "error", data: "relink_required" }).catch(() => {});
      },
    );
    if (!unsub) {
      await stream.writeSSE({ event: "error", data: "could not open live feed" });
      return;
    }
    await stream.writeSSE({ event: "ready", data: "1" });

    // Hold the connection open, pinging through proxies, until the client
    // aborts or STX ends the feed.
    while (!stream.aborted && !ended) {
      await stream.sleep(25000);
      if (stream.aborted || ended) break;
      await stream.writeSSE({ event: "ping", data: "1" }).catch(() => {});
    }
    unsub?.();
  });
});

// GET /api/markets?app=<id> -> the PUBLIC market catalog: every open market.
// No member or session needed; the backend attributes the read to the app with
// an app token (client_credentials, scope market_data), walks STX's REST
// `GET /api/v1/markets` to the last page with the SDK's `iterMarkets`, and
// reshapes it into the catalog shape the frontend consumes. The result is
// cached per app for CATALOG_TTL_MS, so only a real fetch is logged.
apiRoutes.get("/markets", async (c) => {
  const app = requireApp(c);
  const { result, fetched, stale } = await catalogCacheFor(app).get();
  if (fetched) {
    const ok = fetched.status === 200;
    const loaded = `${fetched.markets.length} open markets in ${fetched.pages} ${fetched.pages === 1 ? "page" : "pages"}`;
    activityStore.record({
      ts: Date.now(),
      appId: app.id,
      method: "GET",
      path: config.paths.markets,
      status: fetched.status,
      note: ok ? `Loaded ${loaded}` : `Market catalog failed after ${loaded}`,
      sdkCall: sdkCalls.iterMarkets(MARKET_DATA_SCOPE, CATALOG_QUERY),
      detail: buildDetail({
        method: "GET",
        path: `${config.paths.markets}?status=${CATALOG_QUERY.status.join(",")}&limit=${CATALOG_QUERY.limit}`,
        status: fetched.status,
        responseBody: fetched.firstPage,
        summary: `${loaded}${fetched.truncated ? " (stopped at the cap)" : ""} (first page shown)`,
      }),
    });
  }
  if (result.status !== 200 && result.markets.length === 0) {
    return c.json({ error: "catalog_unavailable", markets: [] }, (result.status || 502) as never);
  }
  return c.json({ markets: result.markets, stale, truncated: result.truncated });
});

// GET /api/markets/:id/trades?app=<id> -> the market's recent public trades
// (the last 15, newest first), in the `trades` channel's row shape. The live
// `trades` feed only pushes executions that happen after the join, so the tape
// is seeded from here and the feed keeps it current. App token, no member.
apiRoutes.get("/markets/:id/trades", async (c) => {
  const app = requireApp(c);
  const marketId = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(marketId)) return c.json({ error: "bad_market_id" }, 400);
  const { status, trades, body } = await fetchRecentTrades(app, marketId);
  const ok = status >= 200 && status < 300;
  activityStore.record({
    ts: Date.now(),
    appId: app.id,
    method: "GET",
    path: `${config.paths.markets}/${marketId}`,
    status,
    note: ok ? `Loaded ${trades.length} recent trades` : "Recent trades failed",
    sdkCall: sdkCalls.market(MARKET_DATA_SCOPE, marketId),
    detail: buildDetail({
      method: "GET",
      path: `${config.paths.markets}/${marketId}`,
      status,
      responseBody: body,
      summary: ok ? `${trades.length} recent trades (market's recent_trades)` : "request failed",
    }),
  });
  if (!ok) return c.json({ error: "trades_unavailable", trades: [] }, (status || 502) as never);
  return c.json({ trades });
});

// GET /api/market-stream?app=<id>&topic=<t>&market_ids=<csv>&range=<r> -> Server-
// Sent Events of the PUBLIC market channels. Mirrors GET /api/stream (the member
// feed): the backend holds the app-token-authenticated STX socket (token never
// reaches the browser) and this same-origin SSE relays what it sees. One
// EventSource == one topic subscription. Valid topics: ticker (market-wide),
// trades / orderbook / market_stats (a market_ids filter is required), and
// market: the live event status (score) of up to 12 markets, relayed as
// `brief` events (see subscribeBriefs in marketProxy.ts). Relayed
// SSE events keep the Phoenix push names (book / ticker / trade / market_stats /
// market_stats_snapshot), plus `joined` (the join reply: market_stats history)
// and `join_error`.
apiRoutes.get("/market-stream", (c) => {
  const app = requireApp(c);
  const topicRaw = c.req.query("topic") ?? "";
  if (!(MARKET_TOPICS as readonly string[]).includes(topicRaw)) {
    return c.json({ error: "bad_topic" }, 400);
  }
  const topic = topicRaw as MarketTopic;
  const marketIds = (c.req.query("market_ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const range = c.req.query("range") ?? null;
  // ticker is market-wide (no filter); the other three require a market.
  if (topic !== "ticker" && marketIds.length === 0) {
    return c.json({ error: "market_ids_required" }, 400);
  }

  // subscribeMarket logs the "Opened market feed" row with the join it makes.
  return streamSSE(c, async (stream) => {
    const unsub = subscribeMarket(app, { topic, marketIds, range }, (e) => {
      stream.writeSSE({ event: e.event, data: JSON.stringify(e.payload) }).catch(() => {});
    });
    stream.onAbort(() => unsub());
    await stream.writeSSE({ event: "ready", data: "1" });

    // Hold the connection open, pinging through proxies, until the client aborts.
    while (!stream.aborted) {
      await stream.sleep(25000);
      if (stream.aborted) break;
      await stream.writeSSE({ event: "ping", data: "1" }).catch(() => {});
    }
    unsub();
  });
});

// GET /api/activity?app=<id>&limit= -> the request log powering the activity
// panel. Without ?app it returns every row.
apiRoutes.get("/activity", (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  const appId = c.req.query("app");
  return c.json({ activity: activityStore.list(limit, appId || undefined) });
});

// GET /api/activity/:id/detail -> the redacted request and response behind one
// row. A row made for a member (their balance, orders) is shown only to that
// member's own session; app-level rows (catalog, token mint) to anyone. Rows
// written before details existed answer { detail: null }.
apiRoutes.get("/activity/:id/detail", (c) => {
  const id = Number(c.req.param("id"));
  const row = Number.isInteger(id) ? activityStore.detail(id) : null;
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.userId) {
    const sid = getSession(c);
    const user = sid && row.appId ? userStore.find(sid, row.appId) : null;
    if (!user || user.id !== row.userId) return c.json({ error: "not_found" }, 404);
  }
  return c.json({ detail: row.detail });
});

// ---- helpers ---------------------------------------------------------------

// One real STX call for the user, to learn whether their link still works. A
// refused refresh drops the link (the SDK does it); an STX 401 that survives a
// refresh drops it here. Anything else (a 5xx, no answer) keeps it.
async function verifyLink(app: AppProfile, user: User): Promise<void> {
  try {
    await memberClient(app, user.id, "Checked the STX link", sdkCalls.balance()).balance();
  } catch (err) {
    const stx = stxErrorResponse(err);
    const dead = err instanceof STXGrantRevokedException || stx?.status === 401;
    if (!dead) return;
    if (linkStore.get(user.id)) linkStore.delete(user.id);
    await closeLiveFeed(app, user.id);
  }
}

// Best-effort revoke the STX grant at STX, drop the local link and close the
// user's live feed. Safe to call when the user has no link.
export async function revokeAndDropLink(app: AppProfile, user: User): Promise<void> {
  if (!linkStore.get(user.id)) return;
  // The SDK revokes the refresh token (which kills the pair) and deletes the
  // link whether or not STX answered.
  const { oauth, tokens } = stxApp(app);
  await oauth.unlink(tokens, user.id);
  await closeLiveFeed(app, user.id);
}

// Thrown for an explicitly-supplied unknown app id. index.ts maps it to 400.
export class UnknownAppError extends Error {
  constructor(public appId: string) {
    super(`Unknown app profile: ${appId}`);
    this.name = "UnknownAppError";
  }
}
