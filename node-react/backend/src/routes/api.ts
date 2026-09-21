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
import { NotLinkedError, stxRequest, stxGraphQL } from "../stxClient";
import { streamSSE } from "hono/streaming";
import { subscribe, type LiveEvent } from "../liveProxy";

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

// GraphQL order mutations. Order WRITES go through GraphQL because the OAuth
// bearer authenticates it and Absinthe enforces the member's `trade` scope; the
// REST order write path assumes an API key. Reads stay on REST (they accept the
// bearer fine), so the demo exercises both API surfaces.
const CONFIRM_ORDER = `mutation Place($order: UserOrder!) {
  confirmOrder(userOrder: $order) {
    order { id status action orderType price quantity filled insertedAt marketId }
    errors
  }
}`;

const CONFIRM_ORDERS = `mutation PlaceBatch($orders: [UserOrder!]!) {
  confirmOrders(userOrders: $orders) {
    results { order { id status action orderType price quantity } errors }
  }
}`;

const CANCEL_ORDER = `mutation Cancel($id: rID!) {
  cancelOrder(orderId: $id) { status }
}`;

// Settlements read via GraphQL. The REST `GET /api/v1/portfolio/settlements`
// path is not covered by any OAuth scope server-side (its scope map leaves the
// `portfolio` REST entry empty), so it 403s for every token — reported to the
// API/SDK. GraphQL's `mySettlementsHistory` IS mapped to `portfolio` and works.
const MY_SETTLEMENTS = `query Settlements {
  mySettlementsHistory {
    totalCount
    settlements {
      id type marketId quantity realizedPnl settledPremium settledRisk fee insertedAtIso
    }
  }
}`;

// Map the demo's flat REST-style order body to the GraphQL UserOrder input:
// enums are upper-case, price is an INTEGER in cents (omitted for market orders),
// quantity is a string.
function toUserOrder(b: Record<string, unknown>): Record<string, unknown> {
  const orderType = String(b.order_type || "limit").toLowerCase();
  const order: Record<string, unknown> = {
    marketId: b.market_id,
    orderType: orderType.toUpperCase(),
    action: String(b.action || "buy").toUpperCase(),
    quantity: String(b.quantity ?? ""),
  };
  if (orderType === "limit" && b.price !== undefined && String(b.price).trim() !== "") {
    order.price = parseInt(String(b.price), 10);
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

// POST /api/orders?app=<id> -> place an order. Body forwarded as-is to STX.
apiRoutes.post("/orders", async (c) => {
  const app = requireApp(c);
  const link = requireLink(requireUser(c, app));
  const payload = await c.req.json().catch(() => ({}));
  const { status, body } = await stxGraphQL(app, link, CONFIRM_ORDER, {
    order: toUserOrder(payload as Record<string, unknown>),
  }, "Placed an order");
  const b = body as { errors?: { message: string }[]; data?: { confirmOrder?: { order?: unknown; errors?: string[] } } };
  const err = b?.errors?.[0]?.message || b?.data?.confirmOrder?.errors?.[0];
  if (err) return c.json({ error: err }, 422);
  return c.json((b?.data?.confirmOrder ?? b) as object, (status === 200 ? 200 : status) as never);
});

// POST /api/orders/batch?app=<id> -> place several orders at once via the
// GraphQL `confirmOrders` batch mutation. Body: { orders: [ <flat order>, ... ] }.
apiRoutes.post("/orders/batch", async (c) => {
  const app = requireApp(c);
  const link = requireLink(requireUser(c, app));
  const payload = (await c.req.json().catch(() => ({}))) as { orders?: unknown };
  const list = Array.isArray(payload.orders) ? payload.orders : [];
  if (list.length === 0) return c.json({ error: "No orders in the batch." }, 400);
  const orders = list.map((o) => toUserOrder(o as Record<string, unknown>));
  const { status, body } = await stxGraphQL(app, link, CONFIRM_ORDERS, { orders }, "Placed a batch of orders");
  const b = body as { errors?: { message: string }[]; data?: { confirmOrders?: unknown } };
  const err = b?.errors?.[0]?.message;
  if (err) return c.json({ error: err }, 422);
  return c.json((b?.data?.confirmOrders ?? b) as object, status as never);
});

// DELETE /api/orders/:id?app=<id> -> cancel an order.
apiRoutes.delete("/orders/:id", async (c) => {
  const app = requireApp(c);
  const link = requireLink(requireUser(c, app));
  const id = c.req.param("id");
  const { status, body } = await stxGraphQL(app, link, CANCEL_ORDER, { id }, "Cancelled an order");
  const b = body as { errors?: { message: string }[]; data?: { cancelOrder?: unknown } };
  const err = b?.errors?.[0]?.message;
  if (err) return c.json({ error: err }, 422);
  return c.json((b?.data?.cancelOrder ?? { ok: true }) as object, status as never);
});

// GET /api/trades?app=<id> -> the member's fills (scope `history`).
apiRoutes.get("/trades", async (c) => {
  const app = requireApp(c);
  const link = requireLink(requireUser(c, app));
  const { status, body } = await stxRequest(app, link, "GET", config.paths.trades, undefined, "Loaded trades");
  return c.json(body as object, status as never);
});

// GET /api/settlements?app=<id> -> the member's settled positions (scope
// `portfolio`), via GraphQL `mySettlementsHistory`. Mapped to the flat,
// snake-case `{ settlements: [...] }` shape the activity UI reads.
apiRoutes.get("/settlements", async (c) => {
  const app = requireApp(c);
  const link = requireLink(requireUser(c, app));
  const { status, body } = await stxGraphQL(app, link, MY_SETTLEMENTS, {}, "Loaded settlements");
  const gq = body as {
    data?: { mySettlementsHistory?: { settlements?: Record<string, unknown>[] } };
  };
  const raw = gq?.data?.mySettlementsHistory?.settlements;
  if (Array.isArray(raw)) {
    const settlements = raw.map((s) => ({
      id: s.id,
      market_id: s.marketId,
      type: s.type,
      quantity: s.quantity,
      realized_pnl: s.realizedPnl,
      settled_premium: s.settledPremium,
      settled_risk: s.settledRisk,
      fee: s.fee,
      settled_at: s.insertedAtIso,
    }));
    return c.json({ settlements }, 200 as never);
  }
  // On a GraphQL error, pass the body through so the UI surfaces it.
  return c.json(body as object, status as never);
});

// GET /api/stream?app=<id> -> Server-Sent Events of the member's LIVE STX
// channel events (fills, balance, orders, positions). The ISV backend holds the
// authenticated STX socket (token never reaches the browser); this same-origin
// SSE just relays what it sees. The browser opens it with EventSource.
apiRoutes.get("/stream", (c) => {
  const app = requireApp(c);
  const link = requireLink(requireUser(c, app));
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
