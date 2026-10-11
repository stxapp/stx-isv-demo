// Login mode `vendor`: the app's login is a login service (Auth0, Clerk, Okta,
// Cognito, Keycloak, ...) in which STX has been added as a login option.
//
// The app talks to the service over standard OpenID Connect and knows nothing
// about which one it is: an issuer URL, a client id and a client secret. Inside
// the service, STX is set up as one of its login options, so its login page
// shows "Continue with STX" next to whatever else the app offers. That setup
// lives in the service's dashboard, not in this code.
//
// Two steps:
//   1. /auth/vendor/start sends the browser to the service. The person logs in
//      there (with their STX account, or any other option), and
//      /auth/vendor/callback verifies the service's ID token and signs them in
//      to the app, keyed on the service's subject.
//   2. The service's token says who the person is. It does not let this app
//      trade for them on STX, so a user with no STX link yet is sent straight
//      on to link their STX account (../link.ts). Having just logged in at STX,
//      they only confirm.
//
// openid-client, the standard library for it, does the protocol work
// (discovery, PKCE, state, nonce, the code exchange and the ID token checks).

import { Hono } from "hono";
import * as oidc from "openid-client";
import { config } from "../../config";
import { getOrCreateSession, getSession, startSession } from "../../session";
import { linkStore, SIGN_IN_FLOW_TTL_MS, signInFlowStore, userStore } from "../../stores";
import { linkRoutes } from "../link";
import { endLiveStreams, finishLink, identityKey, retireSessionUser } from "../shared";
import { displayName } from "../stx";

let discovered: Promise<oidc.Configuration> | null = null;

// The service's configuration, discovered once and reused. A failed discovery
// is not cached, so the next sign-in retries it.
export function vendorConfiguration(): Promise<oidc.Configuration> {
  if (!discovered) {
    const v = config.vendor;
    discovered = oidc
      .discovery(
        new URL(v.issuer),
        v.clientId,
        undefined,
        v.clientAuth === "client_secret_post" ? oidc.ClientSecretPost(v.clientSecret) : oidc.ClientSecretBasic(v.clientSecret),
        v.allowInsecure ? { execute: [oidc.allowInsecureRequests] } : undefined,
      )
      .catch((err) => {
        discovered = null;
        throw err;
      });
  }
  return discovered;
}

// For tests: forget the discovered configuration.
export function resetVendorConfiguration(): void {
  discovered = null;
}

// Where signing out of the app should send the browser so the login service
// forgets them too (its `end_session_endpoint`), or null when it has none.
// Without this, the next "sign in" would silently log the same person back in.
export async function vendorSignOutUrl(): Promise<string | null> {
  try {
    const endpoint = (await vendorConfiguration()).serverMetadata().end_session_endpoint;
    if (!endpoint) return null;
    const url = new URL(endpoint);
    url.searchParams.set("client_id", config.vendor.clientId);
    url.searchParams.set("post_logout_redirect_uri", config.frontendUrl);
    return url.href;
  } catch {
    return null;
  }
}

export function vendorLoginRoutes(): Hono {
  const routes = new Hono();

  // GET /auth/vendor/start
  routes.get("/auth/vendor/start", async (c) => {
    let cfg: oidc.Configuration;
    try {
      cfg = await vendorConfiguration();
    } catch (err) {
      console.error("Login service discovery failed", err);
      return finishLink(c, "error=login_unavailable");
    }

    const codeVerifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    signInFlowStore.save(state, { codeVerifier, nonce, sessionId: getOrCreateSession(c) });

    const params: Record<string, string> = {
      // Deployment-specific extras first, so they can never override the
      // security parameters below.
      ...Object.fromEntries(new URLSearchParams(config.vendor.authorizeParams)),
      redirect_uri: config.vendor.redirectUri,
      scope: config.vendor.scopes,
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: "S256",
      state,
      nonce,
    };
    return c.redirect(oidc.buildAuthorizationUrl(cfg, params).href);
  });

  // GET /auth/vendor/callback?code=&state= (or ?error=)
  routes.get("/auth/vendor/callback", async (c) => {
    const url = new URL(c.req.url);
    const state = url.searchParams.get("state");
    const flow = state ? signInFlowStore.take(state) : null;
    const error = url.searchParams.get("error");
    if (!state || (!error && !url.searchParams.get("code"))) return finishLink(c, "error=missing_code_or_state");
    if (!flow) return finishLink(c, "error=invalid_state");
    if (flow.sessionId !== getSession(c)) return finishLink(c, "error=session_mismatch");
    if (Date.now() - flow.createdAt > SIGN_IN_FLOW_TTL_MS) return finishLink(c, "error=expired");
    // Only now is an error believed: it came back on a sign-in this browser started.
    if (error) return finishLink(c, `error=${encodeURIComponent(error)}`);

    let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
    try {
      const cfg = await vendorConfiguration();
      // The callback URL as registered (behind a load balancer the request URL
      // has the internal scheme and host), with the query the service sent.
      const current = new URL(config.vendor.redirectUri);
      current.search = url.search;
      tokens = await oidc.authorizationCodeGrant(cfg, current, {
        pkceCodeVerifier: flow.codeVerifier,
        expectedState: state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      });
    } catch (err) {
      console.error("Login service sign-in failed", err);
      return finishLink(c, "error=sign_in_failed");
    }

    const claims = tokens.claims();
    if (!claims?.sub) return finishLink(c, "error=sign_in_failed");
    const email = typeof claims.email === "string" ? claims.email : undefined;
    const app = config.app;
    await retireSessionUser(app, flow.sessionId);
    const signedIn = userStore.signInExternal({
      sessionId: flow.sessionId,
      appId: app.id,
      externalId: identityKey("vendor", config.vendor.issuer, claims.sub),
      name: displayName(claims, email, `${app.name} member`),
      email: email ?? null,
      startingWalletCents: app.startingWalletCents,
    });
    // Signed in: from here on the browser uses a session id made just now.
    const user = userStore.moveToSession(signedIn.id, startSession(c));
    await endLiveStreams(app, user.id);
    // The service's own tokens are not kept: the app needs only who this is.

    // Signed in. A user with an STX link is done; one without goes straight on
    // to link their STX account, with their email as a hint.
    if (linkStore.get(user.id)) return finishLink(c, `signed_in=1&app=${app.id}`);
    return c.redirect(`/login${email ? `?login_hint=${encodeURIComponent(email)}` : ""}`);
  });

  // Linking needs the signed-in user the service just vouched for.
  routes.route("/", linkRoutes({ requireSignedIn: true }));
  return routes;
}
