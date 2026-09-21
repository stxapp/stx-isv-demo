// The OAuth 2.0 authorization-code + PKCE machinery, isolated from HTTP routing.
//
// This is the part a port to another stack (Next.js, Python, Go) reimplements;
// keeping it free of framework details makes the contract obvious. See
// docs.stxapp.io/isv for the stack-agnostic description.
//
// Every request-building function takes an `AppProfile` (the ISV app's OAuth
// client) carrying its own client_id/secret/redirect_uri/scopes. The STX
// endpoint paths and base URL belong to the exchange and are read from
// `config`.

import { config, type AppProfile } from "./config";

// ---- PKCE (RFC 7636) -------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  // Bun/Node Buffer base64url — no padding, URL-safe alphabet.
  return Buffer.from(bytes).toString("base64url");
}

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

// A high-entropy code_verifier: 32 random bytes -> 43-char base64url string.
export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

// The S256 challenge is base64url(SHA-256(verifier)). STX rejects `plain`.
export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64url(new Uint8Array(digest));
}

// Opaque, unguessable CSRF token tying /login to /callback.
export function generateState(): string {
  return base64url(randomBytes(24));
}

// ---- Authorize URL ---------------------------------------------------------

// Builds the URL the browser is redirected to, for a given app. The user
// authenticates and consents on STX; STX then redirects back to the app's
// REDIRECT_URI with `code` + `state`.
export function buildAuthorizeUrl(
  app: AppProfile,
  params: { state: string; codeChallenge: string },
): string {
  const url = new URL(config.paths.authorize, config.stxBaseUrl + "/");
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    scope: app.scopes,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    state: params.state,
  }).toString();
  return url.toString();
}

// ---- Token endpoint --------------------------------------------------------

// The STX token response (RFC 6749 §5.1). `token_type` is always "bearer";
// `scope` is the space-delimited effective scope after STX's narrowing.
export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number; // seconds
  scope?: string;
}

// HTTP Basic per client_secret_basic (RFC 6749 §2.3.1): base64(client_id:secret)
// for THIS app. STX authenticates the client from this header alone at
// /oauth/token and /oauth/revoke — client_id/secret are deliberately NOT sent
// in the form body.
export function basicAuthHeader(app: AppProfile): string {
  const raw = `${app.clientId}:${app.clientSecret}`;
  return "Basic " + Buffer.from(raw).toString("base64");
}

// The authorization_code exchange body. STX reads only these params on this
// grant (`code`, `redirect_uri`, `code_verifier`); the client is authenticated
// via HTTP Basic, so no client_id/secret goes in the body. `redirect_uri` is
// the app's — it must match the one sent at /authorize.
export function buildTokenExchangeParams(
  app: AppProfile,
  args: { code: string; codeVerifier: string },
): URLSearchParams {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: app.redirectUri,
    code_verifier: args.codeVerifier,
  });
}

// The refresh_token exchange body. STX reads only `refresh_token` here; the
// client is authenticated via HTTP Basic.
export function buildRefreshParams(refreshToken: string): URLSearchParams {
  return new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

// Parse and validate STX's RFC 6749 §5.1 token response. `access_token` is the
// one strictly-required field; the rest are normalized to their expected types
// or dropped, so a malformed body fails loudly here rather than surfacing as a
// bad Bearer header later. STX access tokens are `stx_at_...`, refresh tokens
// `stx_rt_...`, but this client treats them as opaque strings — it never parses
// or depends on the prefix.
export function parseTokenResponse(json: unknown): TokenResponse {
  if (typeof json !== "object" || json === null) {
    throw new Error("token response was not a JSON object");
  }
  const obj = json as Record<string, unknown>;

  if (typeof obj.access_token !== "string" || obj.access_token === "") {
    throw new Error("token response missing access_token");
  }

  const parsed: TokenResponse = { access_token: obj.access_token };
  if (typeof obj.refresh_token === "string") parsed.refresh_token = obj.refresh_token;
  if (typeof obj.token_type === "string") parsed.token_type = obj.token_type;
  if (typeof obj.expires_in === "number") parsed.expires_in = obj.expires_in;
  if (typeof obj.scope === "string") parsed.scope = obj.scope;
  return parsed;
}

async function postToken(app: AppProfile, body: URLSearchParams): Promise<TokenResponse> {
  const url = new URL(config.paths.token, config.stxBaseUrl + "/").toString();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: basicAuthHeader(app),
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`token endpoint ${res.status}: ${text}`);
  }
  return parseTokenResponse(await res.json());
}

// Exchange an authorization code for tokens, proving PKCE with the verifier.
export function exchangeCode(
  app: AppProfile,
  args: { code: string; codeVerifier: string },
): Promise<TokenResponse> {
  return postToken(app, buildTokenExchangeParams(app, args));
}

// Trade a refresh token for a fresh access/refresh pair. STX rotates the
// refresh token, so callers must persist whatever comes back.
export function refreshTokens(app: AppProfile, refreshToken: string): Promise<TokenResponse> {
  return postToken(app, buildRefreshParams(refreshToken));
}

// Best-effort revocation (RFC 7009) so "unlink" kills the grant server-side,
// not just the local link. Optional — the endpoint may not exist yet.
export async function revokeToken(app: AppProfile, token: string): Promise<boolean> {
  try {
    const url = new URL(config.paths.revoke, config.stxBaseUrl + "/").toString();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: basicAuthHeader(app),
      },
      body: new URLSearchParams({ token }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Convert an expires_in (seconds) into an absolute epoch-ms expiry.
export function expiryFrom(tokenResponse: TokenResponse): number | null {
  return tokenResponse.expires_in
    ? Date.now() + tokenResponse.expires_in * 1000
    : null;
}
