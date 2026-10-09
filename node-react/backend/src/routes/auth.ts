// OAuth flow routes: /login and /callback.
//
// This is the account-LINKING dance from the ISV side: a signed-in Sideline
// user links their STX account. Read top to bottom to follow the flow. The
// mock ISV sign-in itself and unlink live in routes/api.ts.

import { Hono, type Context } from "hono";
import { readCallback, STXOAuthException, type ReadCallback } from "@stxapp/stx-typescript/oauth";
import { buildDetail } from "../activityDetail";
import { config, getApp } from "../config";
import { appFromRequest } from "../helpers";
import { getOrCreateSession } from "../session";
import { privyEnabled } from "../privy";
import { sdkCalls } from "../sdkCall";
import { activityStore, userStore } from "../stores";
import { pendingStore, stxApp, type FlowData } from "../stx";

export const authRoutes = new Hono();

// Finish the linking flow. The flow runs in a POPUP (see startLink), so instead
// of a 302 we return a tiny page that relays the outcome to the opener via
// postMessage and closes itself. Deployed, both windows share the ISV origin,
// so the popup targets its own window.location.origin: no server-side origin
// guess (which would be wrong behind the ALB). In local development the app
// runs on FRONTEND_URL (Vite, :5173) and this page on the backend (:8787), so
// it also posts to FRONTEND_URL's origin; a target that does not match the
// opener is dropped by the browser, so posting to both is safe. If the page
// was opened top-level (popup blocked, or hit directly), there is no opener, so
// it falls back to the original redirect and behaves exactly as before.
function finishLink(c: Context, query: string) {
  const params = new URLSearchParams(query);
  const status = params.has("linked") ? "linked" : "error";
  const msg = {
    type: "stx-link",
    status,
    app: params.get("app") ?? "",
    error: params.get("error") ?? "",
  };
  const heading = status === "linked" ? "Connected to STX ✓" : "Couldn’t complete linking";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>STX linking</title></head>
<body style="margin:0;height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,sans-serif;background:#0e1726;color:#e7eefc">
<div style="text-align:center;padding:24px">
<p style="font-size:16px;margin:0 0 6px">${heading}</p>
<p style="font-size:13px;opacity:.6;margin:0">You can close this window.</p>
</div>
<script>
(function(){
  var msg = ${JSON.stringify(msg)};
  var q = ${JSON.stringify(query)};
  try {
    if (window.opener && !window.opener.closed) {
      var targets = [window.location.origin, ${JSON.stringify(new URL(config.frontendUrl).origin)}];
      targets.forEach(function(t, i){ if (targets.indexOf(t) === i) window.opener.postMessage(msg, t); });
      setTimeout(function(){ try { window.close(); } catch (e) {} }, 250);
      return;
    }
  } catch (e) {}
  window.location.replace(${JSON.stringify(config.frontendUrl)} + "/?" + q);
})();
</script>
</body></html>`;
  return c.html(html);
}

// GET /login?app=<id>
// Start linking for the session's Sideline user (made here if absent).
// Generate PKCE + state, persist them against this session/app/user, and 302
// the browser to STX's /authorize using THIS app's OAuth client.
authRoutes.get("/login", async (c) => {
  const app = appFromRequest(c);
  if (!app) return finishLink(c, "error=unknown_app");

  const sessionId = getOrCreateSession(c);

  // Linking attaches the STX grant to a Sideline user. With a real login
  // (Privy) the user must be signed in first. With the mock sign-in, a visitor
  // who taps "Link your STX account" before signing in gets the demo user the
  // mock sign-in would have made, so the button works from anywhere.
  const signedIn = userStore.find(sessionId, app.id);
  if (privyEnabled() && !signedIn) return finishLink(c, "error=not_signed_in");
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
    extraParams: connectHints(c.req.query("connection"), c.req.query("login_hint")),
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

// Hints from the app's own login for STX's sign-in: `connection` goes straight
// to the same provider (google, apple or x), `login_hint` preselects the
// account. Anything else is dropped. Hints only: the member still signs in.
export function connectHints(connection?: string, loginHint?: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (connection && ["google", "apple", "x"].includes(connection)) params.connection = connection;
  if (loginHint && loginHint.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(loginHint)) params.login_hint = loginHint;
  return params;
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

// GET /callback
// STX redirects here with ?code & ?state (or ?error). Verify state, exchange
// the code (proving PKCE) with the flow's app client, store the tokens against
// the flow's user (account linking), bounce to the frontend.
authRoutes.get("/callback", async (c) => {
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
