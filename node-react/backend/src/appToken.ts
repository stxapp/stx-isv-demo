// App-level OAuth token (client_credentials), for market data the demo reads on
// its OWN behalf — no member, no session.
//
// The member flows in stxClient.ts carry a MEMBER's access token (authorization
// code + refresh). This module is the OTHER OAuth actor: the confidential app
// itself, authenticated by its client_id/client_secret. STX mints an APP token
// from the `client_credentials` grant (RFC 6749 §4.4), scoped to `market_data`.
// That token attributes the public market catalog + market WebSocket channels to
// the app, and — like every token here — never leaves the backend.
//
// A client_credentials token has a fixed lifetime and NO refresh token: when it
// nears expiry you simply mint another with the same credentials. This module is
// the one place that happens. Callers go through `appAuthHeader`/`appToken`, so
// they never see a token, an expiry, or a mint.
//
//   1. cache the current token per client and the clock time it goes stale;
//   2. mint proactively when the cache is empty or within REFRESH_SKEW_MS of
//      expiry (the common path — no failed request);
//   3. `invalidateAppToken` lets a caller drop the cache and re-mint once when
//      STX rejects a token early with a 401 (the reactive safety net).
//
// Keyed by `client_id` so each app profile mints and caches its
// own token independently — the market data is the same, but the attribution is
// the app's.

import { config, type AppProfile } from "./config";
import { basicAuthHeader, parseTokenResponse } from "./oauth";
import { activityStore } from "./stores";

// Re-mint this many ms BEFORE STX's stated expiry: a token valid "now" can still
// be expired by the time the request lands, so treat the last minute as gone.
const REFRESH_SKEW_MS = 60_000;

// The only scope these app tokens ask for: read-only market data. STX narrows to
// the intersection of the client's registered scopes and this request.
const MARKET_DATA_SCOPE = "market_data";

interface Cached {
  accessToken: string;
  // Epoch ms when the token goes stale, or +Infinity when STX returned no
  // expires_in (treat as non-expiring; the 401 safety net still covers it).
  expiresAt: number;
}

// One cached token per client_id, plus an in-flight mint promise per client so
// concurrent callers (many SSE opens at once) share a single token request
// rather than stampeding the token endpoint.
const cache = new Map<string, Cached>();
const inflight = new Map<string, Promise<string>>();

// Records the app-token mint in the activity log, tagged with the app.
function logActivity(app: AppProfile, status: number | null, note: string): void {
  activityStore.record({ ts: Date.now(), appId: app.id, method: "POST", path: config.paths.token, status, note });
}

// POST {base}/oauth/token with HTTP Basic (client_secret_basic) and
// `grant_type=client_credentials&scope=market_data`; cache the result. The
// client is authenticated by the Basic header alone (as at /token elsewhere), so
// nothing about the client goes in the form body but the grant + scope.
async function mint(app: AppProfile): Promise<string> {
  const url = new URL(config.paths.token, config.stxBaseUrl + "/").toString();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(app),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: MARKET_DATA_SCOPE }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logActivity(app, res.status, "app token mint failed");
    throw new Error(`app token endpoint ${res.status}: ${text.slice(0, 300)}`);
  }

  // Same parser as the member grants: `access_token` required, the rest
  // normalized. client_credentials returns no refresh_token — we re-mint.
  const parsed = parseTokenResponse(await res.json());
  const expiresAt = parsed.expires_in ? Date.now() + parsed.expires_in * 1000 : Number.POSITIVE_INFINITY;
  cache.set(app.clientId, { accessToken: parsed.access_token, expiresAt });
  logActivity(app, 200, "minted app token");
  return parsed.access_token;
}

// The cached token if it is present and not within the refresh skew of expiry;
// otherwise null (caller mints).
function cached(app: AppProfile): string | null {
  const c = cache.get(app.clientId);
  if (!c) return null;
  if (Date.now() >= c.expiresAt - REFRESH_SKEW_MS) return null;
  return c.accessToken;
}

// A valid app token for this app, minting proactively if missing or near expiry.
// Concurrent callers for the same client share one in-flight mint.
export async function appToken(app: AppProfile): Promise<string> {
  const good = cached(app);
  if (good) return good;

  const existing = inflight.get(app.clientId);
  if (existing) return existing;

  const p = mint(app).finally(() => inflight.delete(app.clientId));
  inflight.set(app.clientId, p);
  return p;
}

// The `Authorization` header value for an app-attributed data call.
export async function appAuthHeader(app: AppProfile): Promise<string> {
  return `Bearer ${await appToken(app)}`;
}

// Drop the cached token so the next `appToken` mints a fresh one. Called after a
// 401 on a data call (or before a socket reconnect): STX rejected a token we
// still thought was good, so the cache is wrong and the only fix is a re-mint.
export function invalidateAppToken(app: AppProfile): void {
  cache.delete(app.clientId);
}

// Force a brand-new token now. Used on a socket reconnect: never reuse the token
// from a connection that just dropped — it may be why it dropped.
export function freshAppToken(app: AppProfile): Promise<string> {
  invalidateAppToken(app);
  return appToken(app);
}

interface AppResult {
  status: number;
  body: unknown;
}

// An app-attributed STX REST call, with automatic 401 -> re-mint -> retry once.
// The proactive refresh in `appToken` handles expected expiry; this retry is the
// safety net for the rest (a revoked token, clock skew, a server restart). Once,
// not in a loop — a second 401 is a real auth problem (wrong scope, disabled
// app), not an expiry.
export async function appRequest(app: AppProfile, method: string, path: string): Promise<AppResult> {
  let res: Response | null = null;
  for (const attempt of [1, 2] as const) {
    res = await fetch(config.stxBaseUrl + path, {
      method,
      headers: { Authorization: await appAuthHeader(app), Accept: "application/json" },
    });
    if (res.status === 401 && attempt === 1) {
      invalidateAppToken(app);
      continue;
    }
    break;
  }
  const text = await res!.text();
  return { status: res!.status, body: safeJson(text) };
}

function safeJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
