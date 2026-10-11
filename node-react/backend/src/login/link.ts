// Link your STX account: /login and /callback.
//
// A user who is already signed in to the app links their STX account. Read top
// to bottom to follow the flow. The `own` and `vendor` login modes mount these
// routes; in `stx` mode logging in with an STX account links it in the same
// step, so they are not mounted (see ./stx/).

import { Hono } from "hono";
import { readCallback, STXOAuthException, type ReadCallback } from "@stxapp/stx-typescript/oauth";
import { buildDetail } from "../activityDetail";
import { config, getApp } from "../config";
import { appFromRequest } from "../helpers";
import { getOrCreateSession } from "../session";
import { sdkCalls } from "../sdkCall";
import { activityStore, userStore } from "../stores";
import { pendingStore, stxApp, type FlowData } from "../stx";
import { connectHints, finishLink } from "./shared";

export interface LinkOptions {
  // True when the app has a real login: linking then needs a signed-in user.
  // False for the mock login, where a visitor who taps "Link your STX account"
  // first gets the demo user the mock sign-in would have made.
  requireSignedIn: boolean;
}

export function linkRoutes(opts: LinkOptions): Hono {
  const routes = new Hono();

  // GET /login?app=<id>
  // Start linking for the session's Sideline user (made here if absent).
  // Generate PKCE + state, persist them against this session/app/user, and 302
  // the browser to STX's /authorize using THIS app's OAuth client.
  routes.get("/login", async (c) => {
    const app = appFromRequest(c);
    if (!app) return finishLink(c, "error=unknown_app");

    const sessionId = getOrCreateSession(c);

    // Linking attaches the STX grant to one of the app's users.
    const signedIn = userStore.find(sessionId, app.id);
    if (opts.requireSignedIn && !signedIn) return finishLink(c, "error=not_signed_in");
    const user =
      signedIn ??
      userStore.ensure({
        sessionId,
        appId: app.id,
        name: `${app.name} demo user`,
        startingWalletCents: app.startingWalletCents,
      });

    // The SDK makes the PKCE verifier + S256 challenge and the state, persists
    // them (and which app/user this grant links to) in auth_flows, and builds
    // STX's /authorize URL with THIS app's client id, redirect URI and scopes.
    const data: FlowData = { sessionId, appId: app.id, userId: user.id };
    const auth = await stxApp(app).oauth.beginAuthorization(pendingStore, {
      data: { ...data },
      ...connectHints(c.req.query("connection"), c.req.query("login_hint")),
    });
    // No STX request yet: the browser follows this redirect to STX's consent page.
    activityStore.record({
      ts: Date.now(),
      appId: app.id,
      method: "GET",
      path: config.paths.authorize,
      status: 302,
      note: "Sent member to STX to link (browser redirect)",
      sdkCall: sdkCalls.beginAuthorization(),
      userId: user.id,
      detail: authorizeDetail(auth.url),
    });
    return c.redirect(auth.url);
  });

  // GET /callback
  // STX redirects here with ?code & ?state (or ?error). Verify state, exchange
  // the code (proving PKCE) with the flow's app client, store the tokens against
  // the flow's user (account linking), bounce to the frontend.
  routes.get("/callback", async (c) => {
    // Check STX's ?error, the code and the state, and consume the flow: a state
    // is single-use, which also defeats replay.
    let callback: ReadCallback;
    try {
      callback = await readCallback(pendingStore, new URL(c.req.url));
    } catch (err) {
      if (!(err instanceof STXOAuthException)) throw err;
      if (err.error === "invalid_request") return finishLink(c, "error=missing_code_or_state");
      return finishLink(c, `error=${encodeURIComponent(err.error)}`);
    }

    const flow = callback.pending.data as unknown as FlowData;
    const app = getApp(flow.appId);
    const user = userStore.get(flow.userId);
    if (!app || !user) {
      // The app was reconfigured away or the user signed out mid-flow.
      return finishLink(c, "error=link_target_gone");
    }

    // Exchange the code (proving PKCE) with the flow's app client and store the
    // tokens against the flow's user (account linking).
    const { oauth, tokens } = stxApp(app);
    try {
      await oauth.redeemAuthorization(callback, { store: tokens, memberKey: user.id });
    } catch {
      return finishLink(c, `error=token_exchange_failed&app=${app.id}`);
    }

    return finishLink(c, `linked=1&app=${app.id}`);
  });

  return routes;
}

// The /authorize redirect as a detail: the query the browser was sent with,
// minus the one-time state (a CSRF secret until the callback uses it).
function authorizeDetail(url: string) {
  const u = new URL(url);
  if (u.searchParams.has("state")) u.searchParams.set("state", "[redacted]");
  const detail = buildDetail({ method: "GET", path: u.pathname + u.search, status: 302 });
  detail.note = "No STX request yet: the browser follows this redirect to STX's consent page.";
  return detail;
}
