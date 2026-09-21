// OAuth flow routes: /login and /callback.
//
// This is the account-LINKING dance from the ISV side: a signed-in Heater
// user links their STX account. Read top to bottom to follow the flow. The
// mock ISV sign-in itself and unlink live in routes/api.ts.

import { Hono, type Context } from "hono";
import { config } from "../config";
import { appFromRequest } from "../helpers";
import {
  buildAuthorizeUrl,
  codeChallengeS256,
  exchangeCode,
  expiryFrom,
  generateCodeVerifier,
  generateState,
} from "../oauth";
import { getOrCreateSession } from "../session";
import { flowStore, linkStore, userStore } from "../stores";

export const authRoutes = new Hono();

// Finish the linking flow. The flow runs in a POPUP (see startLink), so instead
// of a 302 we return a tiny page that relays the outcome to the opener via
// postMessage and closes itself. The popup runs on the BACKEND origin while the
// opener is the frontend; those are the same origin in a single-origin deploy
// but differ in split dev (frontend :5173, backend :8787). postMessage only
// delivers when the target origin matches the recipient, so we post to both the
// popup's own origin and the configured frontend origin — whichever the opener
// actually is receives it, and the message carries no token, only link status.
// If the page was opened top-level (popup blocked, or hit directly), there is
// no opener, so it falls back to the redirect and behaves exactly as before.
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
<body style="margin:0;height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,sans-serif;background:#0b0b0f;color:#eaeaea">
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
      var targets = [window.location.origin];
      var fe = ${JSON.stringify(config.frontendUrl)};
      if (fe && targets.indexOf(fe) === -1) targets.push(fe);
      targets.forEach(function(t){ try { window.opener.postMessage(msg, t); } catch (e) {} });
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
// Start linking: the caller must already be a signed-in user of this app.
// Generate PKCE + state, persist them against this session/app/user, and 302
// the browser to STX's /authorize using THIS app's OAuth client.
authRoutes.get("/login", async (c) => {
  const app = appFromRequest(c);
  if (!app) return finishLink(c, "error=unknown_app");
  if (!app.enabled) return finishLink(c, `error=app_not_configured&app=${app.id}`);

  const sessionId = getOrCreateSession(c);

  // Linking attaches the STX grant to an existing ISV user, so one must exist.
  const user = userStore.find(sessionId, app.id);
  if (!user) {
    return finishLink(c, `error=not_signed_in&app=${app.id}`);
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await codeChallengeS256(codeVerifier);
  const state = generateState();

  // Persist verifier + state + which app/user this grant links to, so /callback
  // can complete the exchange with the right client and store it correctly.
  flowStore.save(state, { codeVerifier, sessionId, appId: app.id, userId: user.id });

  return c.redirect(buildAuthorizeUrl(app, { state, codeChallenge }));
});

// GET /callback
// STX redirects here with ?code & ?state (or ?error). Verify state, exchange
// the code (proving PKCE) with the flow's app client, store the tokens against
// the flow's user (account linking), bounce to the frontend.
authRoutes.get("/callback", async (c) => {
  const error = c.req.query("error");
  if (error) {
    return finishLink(c, `error=${encodeURIComponent(error)}`);
  }

  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) {
    return finishLink(c, "error=missing_code_or_state");
  }

  // Consume the flow: a state is single-use, which also defeats replay.
  const flow = flowStore.take(state);
  if (!flow) {
    return finishLink(c, "error=invalid_state");
  }

  const app = config.apps[flow.appId];
  const user = userStore.get(flow.userId);
  if (!app || !user) {
    // The app was reconfigured away or the user signed out mid-flow.
    return finishLink(c, "error=link_target_gone");
  }

  try {
    const tokens = await exchangeCode(app, { code, codeVerifier: flow.codeVerifier });
    linkStore.save({
      userId: user.id,
      appId: app.id,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      accessExpiresAt: expiryFrom(tokens),
      scopes: tokens.scope ? tokens.scope.split(" ").filter(Boolean) : [],
    });
  } catch (err) {
    return finishLink(c, `error=token_exchange_failed&app=${app.id}`);
  }

  return finishLink(c, `linked=1&app=${app.id}`);
});
