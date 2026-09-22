// Routes the frontend calls. Three groups:
//   - app + session state: /apps, /me, /login (mock ISV sign-in), /signout
//   - account linking side-effects: /unlink (the OAuth link itself is /login +
//     /callback in routes/auth.ts)
//   - authenticated STX proxies: /wallet, /balance, /orders, /activity
//
// Each STX proxy resolves the active app, the signed-in user for that app, and
// that user's STX link, then attaches the member's bearer token server-side.
// The browser sees JSON, never a token.

import { Hono, type Context } from "hono";
import { config, type AppProfile } from "../config";
import { appFromRequest, centsToDollarString, extractStxCashCents } from "../helpers";
import { revokeToken } from "../oauth";
import { getOrCreateSession, getSession } from "../session";
import {
  activityStore,
  linkStore,
  userStore,
  type AccountLink,
  type User,
} from "../stores";
import { NotLinkedError, stxRequest } from "../stxClient";
import { streamSSE } from "hono/streaming";
import { subscribe, type LiveEvent } from "../liveProxy";
import { fetchCatalog } from "../marketCatalog";
import { MARKET_TOPICS, subscribeMarket, type MarketTopic } from "../marketProxy";

export const apiRoutes = new Hono();

// Public-safe view of an app profile (no secrets).
function publicApp(app: AppProfile) {
  return {
    id: app.id,
    name: app.name,
    tagline: app.tagline,
    brandColor: app.brandColor,
    scopes: app.scopes.split(" ").filter(Boolean),
    enabled: app.enabled,
    isDefault: app.id === config.defaultAppId,
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

// GET /api/apps — the ISV app profile this demo presents as (no secrets).
apiRoutes.get("/apps", (c) => {
  return c.json({ apps: config.appList.map(publicApp), defaultAppId: config.defaultAppId });
});

// POST /api/login?app=<id> — mock ISV sign-in. Body: { name? }. Creates the
// user + wallet for (session, app) if absent (no real auth — this stands in for
// the user already being a Heater customer). Idempotent.
apiRoutes.post("/login", async (c) => {
  const app = requireApp(c);
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
  const name =
    typeof body.name === "string" && body.name.trim() !== ""
      ? body.name.trim()
      : `${app.name} demo user`;

  const sessionId = getOrCreateSession(c);
  const user = userStore.ensure({
    sessionId,
    appId: app.id,
    name,
    startingWalletCents: app.startingWalletCents,
  });
  return c.json({ user: publicUser(user) });
});

// POST /api/signout?app=<id> — sign out of the ISV app entirely: revoke + drop
// the STX link (if any) and remove the user + wallet for (session, app).
apiRoutes.post("/signout", async (c) => {
  const app = requireApp(c);
  const sid = getSession(c);
  if (sid) {
    const user = userStore.find(sid, app.id);
    if (user) {
      await revokeAndDropLink(app, user);
      userStore.remove(sid, app.id);
    }
  }
  return c.json({ ok: true });
});

// POST /api/unlink?app=<id> — unlink the STX account: best-effort revoke at STX
// and drop the local link. Keeps the ISV user + wallet, so they can relink.
apiRoutes.post("/unlink", async (c) => {
  const app = requireApp(c);
  const user = requireUser(c, app);
  await revokeAndDropLink(app, user);
  return c.json({ ok: true });
});

// GET /api/me?app=<id> — everything the frontend needs to render the active
// app: the app profile, the signed-in user (+ wallet), and the STX link status.
apiRoutes.get("/me", (c) => {
  const app = requireApp(c);
  const sid = getSession(c);
  const user = sid ? userStore.find(sid, app.id) : null;
  const link = user ? linkStore.get(user.id) : null;
  return c.json({
    app: publicApp(app),
    user: user ? publicUser(user) : null,
    link: link
      ? { connected: true, scopes: link.scopes, linkedAt: link.linkedAt }
      : { connected: false, scopes: [], linkedAt: null },
  });
});

// GET /api/wallet?app=<id> — the dual-wallet view: the ISV app's OWN wallet
// (authoritative, held here) alongside the STX cash balance (fetched live from
// STX via the link, scope `balance`). Combined total is shown only when the STX
// cash amount can be parsed confidently — otherwise the raw STX body is
// returned and the frontend omits the total rather than inventing one.
apiRoutes.get("/wallet", async (c) => {
  const app = requireApp(c);
  const user = requireUser(c, app);

  const heaterWallet = {
    label: `${app.name} Wallet`,
    walletCents: user.walletCents,
    walletDollars: centsToDollarString(user.walletCents),
    heldBy: app.name,
  };

  const link = linkStore.get(user.id);
  if (!link) {
    return c.json({
      app: app.id,
      heater: heaterWallet,
      stx: { linked: false, balance: null, cashCents: null },
      combinedCents: null,
    });
  }

  const { status, body } = await stxRequest(app, link, "GET", config.paths.balance, undefined, "Checked STX balance");
  const cashCents = status >= 200 && status < 300 ? extractStxCashCents(body) : null;
  return c.json({
    app: app.id,
    heater: heaterWallet,
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
  const app = requireApp(c);
  const link = requireLink(requireUser(c, app));
  const { status, body } = await stxRequest(app, link, "GET", config.paths.balance, undefined, "Checked STX balance");
  return c.json(body as object, status as never);
});

// Map the demo's flat betslip order to the REST order body. The betslip carries
// price in CENTS (integers, e.g. 44); STX's REST order body wants a DOLLAR
// STRING (`"0.44"`), lower-case enums and a string quantity, with price omitted
// for market orders. This is the exact contract of `POST /api/v1/orders`
// (single) and each leg of `POST /api/v1/orders/batched`.
function toRestOrder(b: Record<string, unknown>): Record<string, unknown> {
  const orderType = String(b.order_type || "limit").toLowerCase();
  const order: Record<string, unknown> = {
    market_id: b.market_id,
    order_type: orderType,
    action: String(b.action || "buy").toLowerCase(),
    quantity: String(b.quantity ?? ""),
  };
  if (orderType === "limit" && b.price !== undefined && String(b.price).trim() !== "") {
    order.price = (Math.round(Number(b.price)) / 100).toFixed(2);
  }
  return order;
}

// GET /api/orders?app=<id> -> list the member's orders.
apiRoutes.get("/orders", async (c) => {
  const app = requireApp(c);
  const link = requireLink(requireUser(c, app));
  const { status, body } = await stxRequest(app, link, "GET", config.paths.orders, undefined, "Loaded order history");
  return c.json(body as object, status as never);
});

// POST /api/orders?app=<id> -> place an order via REST `POST /api/v1/orders`.
// The OAuth bearer carries the member's `trade` scope; STX returns its own
// status (2xx on placement, 422 with `{ error }` on rejection), forwarded as-is.
apiRoutes.post("/orders", async (c) => {
  const app = requireApp(c);
  const link = requireLink(requireUser(c, app));
  const payload = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { status, body } = await stxRequest(app, link, "POST", config.paths.orders, toRestOrder(payload), "Placed an order");
  return c.json(body as object, status as never);
});

// POST /api/orders/batch?app=<id> -> place several orders via REST
// `POST /api/v1/orders/batched`. Body: { orders: [ <flat order>, ... ] }. STX
// returns 200 with a per-leg `results` array (`{order}` | `{errors}`); a
// malformed body is a 400 that places nothing. Forwarded as-is.
apiRoutes.post("/orders/batch", async (c) => {
  const app = requireApp(c);
  const link = requireLink(requireUser(c, app));
  const payload = (await c.req.json().catch(() => ({}))) as { orders?: unknown };
  const list = Array.isArray(payload.orders) ? payload.orders : [];
  if (list.length === 0) return c.json({ error: "No orders in the batch." }, 400);
  const orders = list.map((o) => toRestOrder(o as Record<string, unknown>));
  const { status, body } = await stxRequest(app, link, "POST", `${config.paths.orders}/batched`, { orders }, "Placed a batch of orders");
  return c.json(body as object, status as never);
});

// DELETE /api/orders/:id?app=<id> -> cancel an order via REST
// `DELETE /api/v1/orders/:id` (covered by the `trade` scope). STX returns the
// cancelled order on 200, or 404/422 with `{ error }`; forwarded as-is.
apiRoutes.delete("/orders/:id", async (c) => {
  const app = requireApp(c);
  const link = requireLink(requireUser(c, app));
  const id = c.req.param("id");
  const { status, body } = await stxRequest(app, link, "DELETE", `${config.paths.orders}/${encodeURIComponent(id)}`, undefined, "Cancelled an order");
  return c.json(body as object, status as never);
});

// GET /api/trades?app=<id> -> the member's fills (scope `history`).
apiRoutes.get("/trades", async (c) => {
  const app = requireApp(c);
  const link = requireLink(requireUser(c, app));
  const { status, body } = await stxRequest(app, link, "GET", config.paths.trades, undefined, "Loaded trades");
  return c.json(body as object, status as never);
});

// GET /api/settlements?app=<id> -> the member's settled positions (scope
// `portfolio`) via REST `GET /api/v1/portfolio/settlements`. STX already
// returns `{ settlements: [...] }` in snake_case with dollar-string money — the
// shape the activity UI reads — so it is forwarded, normalising only the
// timestamp key the UI expects (`settled_at`).
apiRoutes.get("/settlements", async (c) => {
  const app = requireApp(c);
  const link = requireLink(requireUser(c, app));
  const { status, body } = await stxRequest(app, link, "GET", config.paths.settlements, undefined, "Loaded settlements");
  const rest = body as { settlements?: Record<string, unknown>[] };
  if (Array.isArray(rest?.settlements)) {
    const settlements = rest.settlements.map((s) => ({
      ...s,
      settled_at: s.settled_at ?? s.inserted_at ?? s.inserted_at_iso,
    }));
    return c.json({ settlements }, 200 as never);
  }
  // On a non-2xx (e.g. a scope or auth error), pass the body through.
  return c.json(body as object, status as never);
});

// GET /api/stream?app=<id> -> Server-Sent Events of the member's LIVE STX
// channel events (fills, balance, orders, positions). The ISV backend holds the
// authenticated STX socket (token never reaches the browser); this same-origin
// SSE just relays what it sees. The browser opens it with EventSource.
apiRoutes.get("/stream", (c) => {
  const app = requireApp(c);
  const link = requireLink(requireUser(c, app));
  activityStore.record({
    ts: Date.now(),
    appId: app.id,
    method: "WS",
    path: "/socket (portfolio)",
    status: null,
    note: "Opened live feed",
  });
  return streamSSE(c, async (stream) => {
    let unsub: (() => void) | null = null;
    stream.onAbort(() => unsub?.());

    unsub = await subscribe(app, link, (e: LiveEvent) => {
      stream.writeSSE({ event: e.kind, data: JSON.stringify(e) }).catch(() => {});
    });
    if (!unsub) {
      await stream.writeSSE({ event: "error", data: "could not open live feed" });
      return;
    }
    await stream.writeSSE({ event: "ready", data: "1" });

    // Hold the connection open, pinging through proxies, until the client aborts.
    while (!stream.aborted) {
      await stream.sleep(25000);
      if (stream.aborted) break;
      await stream.writeSSE({ event: "ping", data: "1" }).catch(() => {});
    }
    unsub?.();
  });
});

// GET /api/markets?app=<id>&limit= -> the PUBLIC market catalog. No member or
// session needed; the backend attributes the read to the app with an app token
// (client_credentials, scope market_data), fetches STX's REST
// `GET /api/v1/markets` and reshapes it into the catalog shape the frontend
// consumes. Replaces a direct browser call.
apiRoutes.get("/markets", async (c) => {
  const app = requireApp(c);
  const limit = Math.min(Number(c.req.query("limit") ?? 500), 1000);
  // Only OPEN markets are tradeable and have a live book — filter server-side.
  const { status, markets } = await fetchCatalog(app, { status: ["open"], limit });
  activityStore.record({
    ts: Date.now(),
    appId: app.id,
    method: "GET",
    path: config.paths.markets,
    status,
    note: status >= 200 && status < 300 ? `Loaded ${markets.length} markets` : "Market catalog failed",
  });
  if (status < 200 || status >= 300) {
    return c.json({ error: "catalog_unavailable", markets: [] }, (status || 502) as never);
  }
  return c.json({ markets });
});

// GET /api/market-stream?app=<id>&topic=<t>&market_ids=<csv>&range=<r> -> Server-
// Sent Events of the PUBLIC market channels. Mirrors GET /api/stream (the member
// feed): the backend holds the app-token-authenticated STX socket (token never
// reaches the browser) and this same-origin SSE relays what it sees. One
// EventSource == one topic subscription. Valid topics: ticker (market-wide),
// trades / orderbook / market_stats (a market_ids filter is required). Relayed
// SSE events keep the Phoenix push names (book / ticker / trade / market_stats /
// market_stats_snapshot), plus `joined` (the join reply — market_stats history)
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

  activityStore.record({
    ts: Date.now(),
    appId: app.id,
    method: "WS",
    path: `/socket (${topic})`,
    status: null,
    note: "Opened market feed",
  });

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
// panel, scoped to the app when ?app is given.
apiRoutes.get("/activity", (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  const appId = c.req.query("app");
  return c.json({ activity: activityStore.list(limit, appId || undefined) });
});

// ---- helpers ---------------------------------------------------------------

function publicUser(user: User) {
  return {
    id: user.id,
    name: user.name,
    walletCents: user.walletCents,
    walletDollars: centsToDollarString(user.walletCents),
  };
}

// Best-effort revoke the STX grant at STX, then drop the local link. Safe to
// call when the user has no link.
async function revokeAndDropLink(app: AppProfile, user: User): Promise<void> {
  const link = linkStore.get(user.id);
  if (!link) return;
  await revokeToken(app, link.accessToken);
  linkStore.delete(user.id);
}

// Thrown for an explicitly-supplied unknown app id. index.ts maps it to 400.
export class UnknownAppError extends Error {
  constructor(public appId: string) {
    super(`Unknown app profile: ${appId}`);
    this.name = "UnknownAppError";
  }
}
