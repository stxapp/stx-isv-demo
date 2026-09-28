// The `@stxapp/stx-typescript` call behind each activity row, written as code a
// developer could copy. The activity panel shows it next to the HTTP method and
// path, so the log doubles as a map of how this backend uses the SDK.
//
// Names are the SDK's own: `stx` is the member client from
// `oauth.memberClient(tokens, userId)`, `oauth` the app's `OAuthClient`, `ws`
// the socket from `stx.websocket()`. Long ids are shortened for display.

import type { NewOrderInput } from "@stxapp/stx-typescript";

// A market or order id, shortened past 12 characters: "3f9c2a1b…".
export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

// A value as TypeScript source: strings quoted, arrays and objects literal.
function lit(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(lit).join(", ")}]`;
  if (v && typeof v === "object") {
    const parts = Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${k}: ${lit(x)}`);
    return parts.length ? `{ ${parts.join(", ")} }` : "{}";
  }
  return String(v);
}

function ids(list: readonly string[]): string[] {
  return list.map(shortId);
}

// ---- member REST calls (stx = oauth.memberClient(tokens, userId)) -------------

export const sdkCalls = {
  balance: () => "stx.balance()",
  orders: () => "stx.orders()",
  fills: () => "stx.fills()",
  settlements: () => "stx.settlements()",
  cancelOrder: (orderId: string) => `stx.cancelOrder(${lit(shortId(orderId))})`,

  placeOrder(order: NewOrderInput): string {
    const { marketId, action, orderType, ...opts } = order;
    return `stx.placeOrder(${lit(shortId(marketId))}, ${lit(action)}, ${lit(orderType)}, ${lit(opts)})`;
  },

  placeOrders(orders: readonly NewOrderInput[]): string {
    const legs = orders.map((o) => lit({ ...o, marketId: shortId(o.marketId) }));
    return `stx.placeOrders([${legs.join(", ")}])`;
  },

  // ---- OAuth (oauth = the app's OAuthClient) ----------------------------------

  beginAuthorization: () => "oauth.beginAuthorization(pendingStore, { data: { sessionId, appId, userId } })",
  redeemAuthorization: () =>
    "oauth.redeemAuthorization(await readCallback(pendingStore, url), { store: tokens, memberKey: userId })",
  refresh: () => "session.refresh(refreshToken) // automatic (SDK single-flight refresh)",
  appToken: (scope: string) => `oauth.appToken(${lit(scope)}).get() // automatic (app token for oauth.appClient)`,
  unlink: () => "oauth.unlink(tokens, userId)",

  // ---- app-token REST (catalog = oauth.appClient("market_data")) -------------

  markets: (scope: string, query: { status: string[]; limit: number }) =>
    `oauth.appClient(${lit(scope)}).markets(${lit(query)})`,
  market: (scope: string, marketId: string) => `oauth.appClient(${lit(scope)}).market(${lit(shortId(marketId))})`,

  // ---- sockets ------------------------------------------------------------------

  // The member id for the private topics: `GET /api/v1/me`, or the balance when
  // the grant lacks `profile.read`.
  wsUserId: (operationId: string) =>
    operationId === "me_get" ? "await ws.userId() // stx.me()" : "await ws.userId() // falls back to stx.balance()",

  // The live feed on a full grant: one call joins balances, orders, fills and
  // positions, seeds from their snapshots and keeps the view current.
  accountView: () => "const ws = stx.websocket({ onReconnect }); const view = await ws.accountView({ onChange })",

  // The member channel joins the live feed made, in order, for a grant without
  // every account scope. Each joins `<kind>:<userId>`.
  memberJoins: (kinds: readonly string[]) =>
    ["const ws = stx.websocket()", ...kinds.map((k) => `await ws.${k}({ onMessage })`)].join("; "),

  // One public market channel join on the app-token socket.
  marketJoin(scope: string, sub: { topic: string; marketIds: readonly string[]; range?: string | null }): string {
    const ws = `oauth.appClient(${lit(scope)}).websocket()`;
    const m = ids(sub.marketIds);
    switch (sub.topic) {
      case "orderbook":
        return `${ws}.orderbook(${lit(m)}, { onMessage })`;
      case "trades":
        return `${ws}.trades({ marketIds: ${lit(m)}, onMessage })`;
      case "market_stats":
        return `${ws}.marketStats(${lit(m)}, { range: ${lit(sub.range ?? "all")}, onMessage })`;
      case "market":
        // One join per market on the same socket.
        return m.map((id) => `${ws}.market(${lit(id)}, { onMessage })`).join("\n");
      default:
        return `${ws}.ticker({ onMessage })`;
    }
  },
};
