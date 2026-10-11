// The app's own login, when it is Privy: verify a Privy access token on the
// server and read who the user is and how they signed in.
//
// Privy is only what this demo uses. Nothing here is special to it: swap the
// verifier for your own login's "who is this request from" check and the rest
// of the app is unchanged. STX is linked afterwards (../link.ts).
// How the user signed in to Privy becomes a hint for the STX connect step:
// `connection` takes them straight to the same provider, `loginHint` preselects
// their account. Hints only: the member still signs in to STX themselves.

import { PrivyClient } from "@privy-io/server-auth";
import { Hono } from "hono";
import { config } from "../../config";
import { publicUser } from "../../helpers";
import { getOrCreateSession, startSession } from "../../session";
import { endLiveStreams, retireMockUser } from "../shared";
import { userStore } from "../../stores";

export interface PrivyIdentity {
  /** Privy's user id (did:privy:...). The app's user is keyed on it. */
  userId: string;
  name: string;
  /** How they signed in to Privy, as an STX `connection`: google or x; absent for email. */
  connection?: "google" | "x";
  /** Their email, to preselect the account on STX. */
  email?: string;
}

export type PrivyVerifier = (accessToken: string) => Promise<PrivyIdentity>;

let override: PrivyVerifier | null = null;

/** Tests swap the Privy call for a stub. */
export function setPrivyVerifier(v: PrivyVerifier | null): void {
  override = v;
}

let client: PrivyClient | null = null;

/** Verifies the token (signature, issuer, audience, expiry) and loads the user. Throws if invalid. */
export async function verifyPrivyUser(accessToken: string): Promise<PrivyIdentity> {
  if (override) return override(accessToken);
  if (!config.privyAppId || !config.privyAppSecret) throw new Error("Privy is not configured");
  client ??= new PrivyClient(config.privyAppId, config.privyAppSecret);
  const claims = await client.verifyAuthToken(accessToken);
  const user = await client.getUserById(claims.userId);
  if (user.google) {
    return { userId: user.id, name: user.google.name ?? user.google.email, connection: "google", email: user.google.email };
  }
  if (user.twitter) {
    return {
      userId: user.id,
      name: user.twitter.name ?? user.twitter.username ?? "X user",
      connection: "x",
      email: user.email?.address,
    };
  }
  const email = user.email?.address;
  return { userId: user.id, name: email ?? "Member", email };
}

export function privyLoginRoutes(): Hono {
  const routes = new Hono();

  // POST /api/login/privy. Body: { accessToken } from the browser's Privy SDK.
  // The token is verified here; the user is keyed on the Privy user id, so a
  // returning user gets their wallet and STX link back on any browser. Answers
  // with the hint for the link step (how they signed in, and their email).
  routes.post("/api/login/privy", async (c) => {
    const app = config.app;
    const body = (await c.req.json().catch(() => ({}))) as { accessToken?: unknown };
    if (typeof body.accessToken !== "string" || body.accessToken === "") {
      return c.json({ error: "missing_access_token" }, 400);
    }
    let who: PrivyIdentity;
    try {
      who = await verifyPrivyUser(body.accessToken);
    } catch {
      return c.json({ error: "invalid_privy_token", message: "Your sign-in could not be verified. Sign in again." }, 401);
    }
    const sessionId = getOrCreateSession(c);
    await retireMockUser(app, sessionId);
    const signedIn = userStore.signInExternal({
      sessionId,
      appId: app.id,
      externalId: who.userId,
      name: who.name,
      email: who.email ?? null,
      startingWalletCents: app.startingWalletCents,
    });
    // Signed in: from here on the browser uses a session id made just now.
    const user = userStore.moveToSession(signedIn.id, startSession(c));
    await endLiveStreams(app, user.id);
    return c.json({
      user: publicUser(user),
      connectHint: { connection: who.connection ?? null, loginHint: who.email ?? null },
    });
  });

  return routes;
}
