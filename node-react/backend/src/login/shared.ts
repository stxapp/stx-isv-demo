// What every login mode shares: the small page that ends a trip to STX (or to
// a login service) and reports the result to the app, and the hints an app can
// pass to STX's sign-in.

import type { Context } from "hono";
import { config, type AppProfile } from "../config";
import { closeLiveFeed } from "../liveProxy";
import { revokeAndDropLink } from "../routes/api";
import { userStore } from "../stores";

// End a trip to STX or to a login service. The trip runs in a POPUP on wide
// screens (see the frontend's startLink), so instead of a 302 this returns a
// tiny page that relays the outcome to the opener via postMessage and closes
// itself. Deployed, both windows share the app's origin, so the popup targets
// its own window.location.origin: no server-side origin guess (which would be
// wrong behind a load balancer). In local development the app runs on
// FRONTEND_URL (Vite, :5173) and this page on the backend (:8787), so it also
// posts to FRONTEND_URL's origin; a target that does not match the opener is
// dropped by the browser, so posting to both is safe. If the page was opened
// top-level (a phone, a blocked popup, or hit directly), there is no opener,
// so it sends the browser back to the app with the same outcome in the query.
//
// `query` is the outcome: `linked=1` (an STX account is linked), `signed_in=1`
// (signed in, and already linked) or `error=<code>`.
export function finishLink(c: Context, query: string) {
  const params = new URLSearchParams(query);
  const status = params.has("linked") ? "linked" : params.has("signed_in") ? "signed_in" : "error";
  const msg = {
    type: "stx-link",
    status,
    app: params.get("app") ?? "",
    error: params.get("error") ?? "",
  };
  const heading =
    status === "linked" ? "Connected to STX ✓" : status === "signed_in" ? "Signed in ✓" : "Couldn’t complete sign-in";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Returning to the app</title></head>
<body style="margin:0;height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,sans-serif;background:#0e1726;color:#e7eefc">
<div style="text-align:center;padding:24px">
<p style="font-size:16px;margin:0 0 6px">${heading}</p>
<p style="font-size:13px;opacity:.6;margin:0">You can close this window.</p>
</div>
<script>
(function(){
  var msg = ${forScript(msg)};
  var q = ${forScript(query)};
  try {
    if (window.opener && !window.opener.closed) {
      var targets = [window.location.origin, ${forScript(new URL(config.frontendUrl).origin)}];
      targets.forEach(function(t, i){ if (targets.indexOf(t) === i) window.opener.postMessage(msg, t); });
      setTimeout(function(){ try { window.close(); } catch (e) {} }, 250);
      return;
    }
  } catch (e) {}
  window.location.replace(${forScript(config.frontendUrl)} + "/?" + q);
})();
</script>
</body></html>`;
  return c.html(html);
}

// A value written into the page's inline script. JSON alone is not enough
// there: the outcome carries text from the callback's query string, and a
// "</script>" inside a JSON string would end the script block. The characters
// HTML or the script parser treat specially are written as \u escapes, which
// JavaScript reads back as the same text.
export function forScript(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// The key one of the app's users is stored under when a login vouches for
// them: who vouched (`stx` or `vendor`), the issuer that said so, and its
// subject for the person. A subject means something only to the issuer that
// gave it, so the issuer is part of the key: pointing the app at a different
// exchange or login service can never land someone on another person's user.
export function identityKey(kind: "stx" | "vendor", issuer: string, sub: string): string {
  return `${kind}:${issuer.replace(/\/+$/, "")}|${sub}`;
}

// Before someone signs in on a browser that holds a mock user: that user is
// about to be replaced (see userStore.signInExternal), so end its STX link
// properly first: revoke at STX and close its live feed.
export async function retireMockUser(app: AppProfile, sessionId: string): Promise<void> {
  const here = userStore.find(sessionId, app.id);
  if (here && !here.externalId) await revokeAndDropLink(app, here);
}

// After a user is signed in on this browser, or signed out of it: end every
// live stream already open for them. A stream is tied to the user it was
// opened for, not to a cookie, so one opened from a browser that no longer
// holds them would otherwise keep receiving their account. This browser's own
// stream simply reconnects.
export async function endLiveStreams(app: AppProfile, userId: string): Promise<void> {
  await closeLiveFeed(app, userId);
}

// Hints from the app's own login for STX's sign-in: `connection` goes straight
// to the same provider (google, apple or x), `login_hint` preselects the
// account. Anything else is dropped. Hints only: the member still signs in.
export function connectHints(connection?: string, loginHint?: string): { connection?: string; loginHint?: string } {
  const params: { connection?: string; loginHint?: string } = {};
  if (connection && ["google", "apple", "x"].includes(connection)) params.connection = connection;
  if (loginHint && loginHint.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(loginHint)) params.loginHint = loginHint;
  return params;
}
