// Login mode `stx`: people register or log in with their STX account. The app
// has no login of its own.
//
// One button does three things: it signs the person in to the app, sets up
// their STX account if they are new (STX hosts that page: email and password,
// Google, X or Apple, then its one-time onboarding), and links the account for
// trading. STX returns here with a code, and this backend exchanges it for:
//   - the trading tokens, stored server-side against the app's user (the
//     browser only ever holds an httpOnly session cookie), and
//   - a signed ID token, verified by the SDK, whose `sub` is the member's
//     stable STX id for this app. The app's user is found or created on it, so
//     a returning member lands on the same account with no second sign-up.
//
// The STX TypeScript SDK's `createConnect` does the protocol work: reading
// STX's published sign-in configuration, PKCE, state, nonce, the code exchange
// and the ID token checks.

import { Hono } from "hono";
import {
  createConnect,
  STXAccessDeniedException,
  STXAccountPendingException,
  STXOAuthException,
  type Connect,
} from "@stxapp/stx-typescript/oauth";
import { config } from "../../config";
import { getOrCreateSession, getSession, startSession } from "../../session";
import { activityStore, SIGN_IN_FLOW_TTL_MS, signInFlowStore, userStore } from "../../stores";
import { stxApp } from "../../stx";
import { connectHints, endLiveStreams, finishLink, identityKey, retireSessionUser } from "../shared";

let connect: Connect | null = null;

// One helper for the app, built on first use. It reads STX's sign-in
// configuration once and caches it; a failed read is retried on the next call.
export function stxConnect(): Connect {
  connect ??= createConnect({
    issuer: config.stxLogin.issuer,
    clientId: config.app.clientId,
    clientSecret: config.app.clientSecret,
    redirectUri: config.stxLogin.redirectUri,
    // `openid` is added by the SDK: it is what asks for the ID token.
    scopes: config.app.scopes,
  });
  return connect;
}

// For tests: forget the helper (and with it the cached configuration).
export function resetStxConnect(): void {
  connect = null;
}

export function stxLoginRoutes(): Hono {
  const routes = new Hono();

  // GET /auth/stx/start?connection=google&login_hint=<email>
  // No parameters: STX's own page, where the person picks how to sign in or
  // registers. `connection` goes straight to Google, Apple or X.
  routes.get("/auth/stx/start", async (c) => {
    let started: Awaited<ReturnType<Connect["start"]>>;
    try {
      started = await stxConnect().start(connectHints(c.req.query("connection"), c.req.query("login_hint")));
    } catch (err) {
      console.error("Could not read STX's sign-in configuration", err);
      return finishLink(c, "error=stx_unavailable");
    }
    signInFlowStore.save(started.state, {
      codeVerifier: started.codeVerifier,
      nonce: started.nonce,
      sessionId: getOrCreateSession(c),
    });
    return c.redirect(started.url);
  });

  // GET /auth/stx/callback?code=&state= (or ?error=)
  routes.get("/auth/stx/callback", async (c) => {
    const query = new URL(c.req.url).searchParams;
    const state = query.get("state");

    // The state must be one this browser started, and recently. It is single
    // use: taking it here means a replayed callback finds nothing.
    const flow = state ? signInFlowStore.take(state) : null;
    const error = query.get("error");
    if (!state || (!error && !query.get("code"))) return finishLink(c, "error=missing_code_or_state");
    if (!flow) return finishLink(c, "error=invalid_state");
    if (flow.sessionId !== getSession(c)) return finishLink(c, "error=session_mismatch");
    if (Date.now() - flow.createdAt > SIGN_IN_FLOW_TTL_MS) return finishLink(c, "error=expired");
    // Only now is an error believed: it came back on a sign-in this browser started.
    if (error) return finishLink(c, `error=${encodeURIComponent(error)}`);

    let finished: Awaited<ReturnType<Connect["finish"]>>;
    try {
      finished = await stxConnect().finish(query, {
        state,
        codeVerifier: flow.codeVerifier,
        nonce: flow.nonce,
        redirectUri: config.stxLogin.redirectUri,
      });
    } catch (err) {
      if (err instanceof STXAccessDeniedException) return finishLink(c, "error=access_denied");
      if (err instanceof STXAccountPendingException) return finishLink(c, "error=account_pending");
      console.error("STX sign-in failed", err instanceof STXOAuthException ? `${err.error}: ${err.message}` : err);
      return finishLink(c, "error=sign_in_failed");
    }

    const { identity, tokens } = finished;
    const app = config.app;
    await retireSessionUser(app, flow.sessionId);
    const signedIn = userStore.signInExternal({
      sessionId: flow.sessionId,
      appId: app.id,
      // Key the user on the member's stable STX id at this exchange, never on
      // the email.
      externalId: identityKey("stx", config.stxLogin.issuer, identity.sub),
      name: displayName(identity.claims, identity.email, `${app.name} member`),
      email: identity.email ?? null,
      startingWalletCents: app.startingWalletCents,
    });
    // Signed in: from here on the browser uses a session id made just now.
    const user = userStore.moveToSession(signedIn.id, startSession(c));
    await endLiveStreams(app, user.id);
    await stxApp(app).tokens.set(user.id, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
    });
    activityStore.record({
      ts: Date.now(),
      appId: app.id,
      method: "POST",
      path: config.paths.token,
      status: 200,
      note: "Logged in with an STX account (code exchanged, ID token verified)",
      sdkCall: "await connect.finish(callbackUrl, saved)",
      userId: user.id,
    });

    return finishLink(c, `linked=1&app=${app.id}`);
  });

  return routes;
}

// A name to show for the person, from the claims a login returned.
export function displayName(claims: Record<string, unknown>, email: string | undefined, fallback: string): string {
  const pick = (k: string) => (typeof claims[k] === "string" && claims[k] !== "" ? (claims[k] as string) : null);
  return pick("name") ?? pick("given_name") ?? pick("nickname") ?? (email ? email.split("@")[0]! : null) ?? fallback;
}
