// The app's own login, when it is Privy: verify a Privy access token on the
// server and read who the user is and how they signed in.
//
// Privy is this app's account system; STX is connected afterwards (routes/auth.ts).
// How the user signed in to Privy becomes a hint for the STX connect step:
// `connection` takes them straight to the same provider, `loginHint` preselects
// their account. Hints only: the member still signs in to STX themselves.

import { PrivyClient } from "@privy-io/server-auth";
import { config } from "./config";

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

export function privyEnabled(): boolean {
  return override !== null || (config.privyAppId !== null && config.privyAppSecret !== null);
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
