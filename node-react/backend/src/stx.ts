// Every STX call this backend makes goes through the STX TypeScript SDK
// (`@stxapp/stx-typescript`, from npm). This module wires the SDK to the
// demo's own persistence and activity log:
//
//   - one `OAuthClient` for the app: its client id, secret, redirect URI and
//     scopes;
//   - `LinkTokenStore`: the SDK's `TokenStore` over the SQLite account_links
//     table, keyed by the ISV user id;
//   - `FlowPendingStore`: the SDK's `PendingAuthorizationStore` over the SQLite
//     auth_flows table (PKCE verifier + state between /login and /callback);
//   - `memberClient()`: an `STX` REST client acting for one linked user. The
//     SDK attaches the bearer token, refreshes it before expiry and once on a
//     401 (single-flight per user, so parallel requests refresh once), and
//     deletes the link when STX rejects the refresh (`invalid_grant`);
//   - `stxApp(app).catalog`: an `STX` client on the app's own `client_credentials`
//     token (scope `market_data`) for the public catalog and market sockets.
//
// Tokens and the client secret never leave the backend.

import { STX, STXException, type ResponseEvent } from "@stxapp/stx-typescript";
import {
  OAuthClient,
  type PendingAuthorization,
  type PendingAuthorizationStore,
  type StoredTokens,
  type TokenStore,
} from "@stxapp/stx-typescript/oauth";
import { config, getApp, type AppProfile } from "./config";
import { buildDetail } from "./activityDetail";
import { sdkCalls } from "./sdkCall";
import { activityStore, flowStore, linkStore } from "./stores";

// The only scope app tokens ask for: read-only market data.
export const MARKET_DATA_SCOPE = "market_data";

// ---- SDK stores over SQLite -------------------------------------------------

// The SDK's TokenStore over account_links, for one app. The member key is the
// ISV user id; a link that belongs to another app is invisible here.
export class LinkTokenStore implements TokenStore {
  constructor(readonly appId: string) {}

  get(userId: string): StoredTokens | null {
    const link = linkStore.get(userId);
    if (!link || link.appId !== this.appId) return null;
    return {
      accessToken: link.accessToken,
      refreshToken: link.refreshToken ?? undefined,
      expiresAt: link.accessExpiresAt ?? undefined,
      scope: link.scopes.join(" "),
    };
  }

  // Called on link (code exchange) and on every refresh. linkStore.save keeps
  // the original linkedAt on update.
  set(userId: string, tokens: StoredTokens): void {
    linkStore.save({
      userId,
      appId: this.appId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? null,
      accessExpiresAt: tokens.expiresAt ?? null,
      scopes: (tokens.scope ?? "").split(" ").filter(Boolean),
    });
  }

  // Called on unlink, and by the SDK when STX rejects the refresh token
  // (revoked grant, or reuse detection): the UI then shows "not linked".
  delete(userId: string): void {
    linkStore.delete(userId);
  }
}

// The data carried from /login to /callback in a pending sign-in.
export interface FlowData {
  sessionId: string;
  appId: string;
  userId: string;
}

// The SDK's PendingAuthorizationStore over auth_flows. A state is single use
// (flowStore.take deletes it). The redirect URI and scope are the app's own,
// so they are rebuilt from the profile rather than stored.
export class FlowPendingStore implements PendingAuthorizationStore {
  put(state: string, pending: PendingAuthorization): void {
    const data = pending.data as unknown as FlowData;
    flowStore.save(state, {
      codeVerifier: pending.codeVerifier,
      sessionId: data.sessionId,
      appId: data.appId,
      userId: data.userId,
    });
  }

  take(state: string): PendingAuthorization | null {
    const flow = flowStore.take(state);
    if (!flow) return null;
    const app = getApp(flow.appId);
    return {
      codeVerifier: flow.codeVerifier,
      redirectUri: app?.redirectUri ?? "",
      scope: app?.scopes,
      // auth_flows has no expiry column; a state lives until it is used.
      expiresAt: Number.POSITIVE_INFINITY,
      data: { sessionId: flow.sessionId, appId: flow.appId, userId: flow.userId },
    };
  }
}

export const pendingStore = new FlowPendingStore();

// ---- The app's SDK clients -------------------------------------------------

export interface StxApp {
  profile: AppProfile;
  oauth: OAuthClient;
  tokens: LinkTokenStore;
  // The app acting as itself: public catalog and public market channels.
  catalog: STX;
}

const apps = new Map<string, StxApp>();

// The SDK objects for one app profile, built once. One OAuthClient per app is
// what makes refreshes single-flight per user and app tokens shared.
export function stxApp(profile: AppProfile): StxApp {
  let app = apps.get(profile.id);
  if (!app) {
    const oauth = new OAuthClient({
      baseUrl: config.stxBaseUrl,
      clientId: profile.clientId,
      clientSecret: profile.clientSecret,
      redirectUri: profile.redirectUri,
      scope: profile.scopes,
      endpoints: { authorize: config.paths.authorize, token: config.paths.token, revoke: config.paths.revoke },
      fetch: tokenLoggingFetch(profile),
    });
    // No per-page activity rows: GET /api/markets logs one "Loaded N markets" row.
    const catalog = oauth.appClient(MARKET_DATA_SCOPE);
    app = { profile, oauth, tokens: new LinkTokenStore(profile.id), catalog };
    apps.set(profile.id, app);
  }
  return app;
}

// The SDK call behind an activity row: fixed code, or code chosen from the
// HTTP attempt (e.g. `ws.userId()` reads `me` or falls back to the balance).
export type SdkCall = string | ((e: ResponseEvent) => string);

// A REST client acting for one linked ISV user. `label` is the activity-panel
// note for the calls it makes; `sdkCall` the @stxapp/stx-typescript call, as code.
export function memberClient(profile: AppProfile, userId: string, label?: string, sdkCall?: SdkCall): STX {
  const app = stxApp(profile);
  return app.oauth.memberClient(app.tokens, userId, { onResponse: logResponse(profile.id, userId, label, sdkCall) });
}

// ---- Activity log -------------------------------------------------------------

// One activity row per STX HTTP attempt, path without the query string. A 401
// followed by a refresh and a retry shows as two rows, as it happened, both
// with the same SDK call; the retry says so in its note. The request and
// response bodies (SDK 0.4.1+) are stored redacted, as the row's detail.
function logResponse(appId: string, userId: string, label?: string, sdkCall?: SdkCall): (e: ResponseEvent) => void {
  let lastStatus: number | null = null;
  return (e) => {
    let note = label ?? null;
    if (e.attempt > 1) {
      const why = lastStatus === 401 ? "retry after token refresh" : `retry, attempt ${e.attempt}`;
      note = note ? `${note} (${why})` : why;
    }
    lastStatus = e.status;
    activityStore.record({
      ts: Date.now(),
      appId,
      method: e.method,
      path: e.path.split("?")[0] ?? e.path,
      status: e.status,
      note,
      sdkCall: typeof sdkCall === "function" ? sdkCall(e) : (sdkCall ?? null),
      userId,
      detail: buildDetail({
        method: e.method,
        path: e.path,
        requestBody: e.requestBody,
        status: e.status,
        responseBody: e.responseBody ?? undefined,
        summary: e.status === null ? "no response (timeout or network error)" : undefined,
      }),
    });
  };
}

// The activity note and SDK call for one token-endpoint request, by grant.
// Null for a request that is not logged here.
function tokenRow(body: URLSearchParams, ok: boolean): { note: string; sdkCall: string } | null {
  switch (body.get("grant_type")) {
    case "refresh_token":
      return { note: ok ? "refreshed access token" : "refresh failed", sdkCall: sdkCalls.refresh() };
    case "client_credentials":
      return {
        note: ok ? "minted app token" : "app token mint failed",
        sdkCall: sdkCalls.appToken(body.get("scope") ?? MARKET_DATA_SCOPE),
      };
    case "authorization_code":
      return { note: ok ? "Linked STX account" : "Code exchange failed", sdkCall: sdkCalls.redeemAuthorization() };
    default:
      return null;
  }
}

// Wraps fetch for one app's OAuthClient to log token-endpoint calls (code
// exchange, refresh and app-token mint) and revocation. Every other request
// passes through untouched. The logged detail is the form sent and the JSON
// returned with every token, code, verifier and the client secret redacted.
function tokenLoggingFetch(profile: AppProfile): (input: string, init: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const res = await fetch(input, init);
    if (init?.method !== "POST") return res;
    const path = new URL(input).pathname;
    const body = new URLSearchParams(String(init.body ?? ""));
    const row =
      path === config.paths.token
        ? tokenRow(body, res.ok)
        : path === config.paths.revoke
          ? { note: res.ok ? "Revoked STX grant" : "Revoke failed", sdkCall: sdkCalls.unlink() }
          : null;
    if (row) {
      const responseText = await res
        .clone()
        .text()
        .catch(() => undefined);
      activityStore.record({
        ts: Date.now(),
        appId: profile.id,
        method: "POST",
        path,
        status: res.status,
        note: row.note,
        sdkCall: row.sdkCall,
        detail: buildDetail({
          method: "POST",
          path,
          requestBody: String(init.body ?? ""),
          status: res.status,
          responseBody: responseText,
        }),
      });
    }
    return res;
  };
}

// ---- Errors -------------------------------------------------------------------

// Thrown when the caller has no signed-in user, or that user has not linked an
// STX account yet. index.ts turns it into a clean 401.
export class NotLinkedError extends Error {
  constructor(message = "No linked STX account. Sign in and link first.") {
    super(message);
    this.name = "NotLinkedError";
  }
}

// STX's own status and body from an SDK error, so a proxy route forwards them
// to the browser exactly as it did before the SDK. Null for an error that is
// not an STX HTTP answer (a transport failure, a bug).
export function stxErrorResponse(err: unknown): { status: number; body: unknown } | null {
  if (err instanceof STXException && err.statusCode !== undefined) {
    return { status: err.statusCode, body: err.body ?? { error: err.message } };
  }
  return null;
}
