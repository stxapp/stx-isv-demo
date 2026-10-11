// Unit tests for the OAuth wiring against the real STX contract. No live server
// is needed: `fetch` is replaced by a scripted mock, and the tests assert the
// *shape* of every request the SDK sends and what lands in the demo's own
// stores, which is what a live exchange would exercise.
//
// `config` reads required env vars at import time, so set them before importing
// the modules under test (hence the top-level await imports below).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

process.env.STX_BASE_URL = "https://stx.example.com";
// The app profile: Sideline.
process.env.CLIENT_ID = "sideline-test-client-id";
process.env.CLIENT_SECRET = "sideline-test-client-secret";
process.env.REDIRECT_URI = "http://localhost:8787/callback";
process.env.OAUTH_SCOPES = "profile.read balance.read portfolio.read orders.read orders.write";
// The `config` singleton is shared across test files in one process; this env
// block matches stores.test.ts (incl. DB_PATH) so whichever loads it first,
// both see the same profile and an in-memory DB.
process.env.DB_PATH = ":memory:";

const { codeChallengeS256, generateCodeVerifier, parseTokenResponse, readCallback, STXGrantRevokedException } =
  await import("@stxapp/stx-typescript/oauth");
const { config, getApp } = await import("./config");
const { db } = await import("./db");
const { activityStore, linkStore, userStore } = await import("./stores");
const { memberClient, pendingStore, stxApp } = await import("./stx");
const { apiRoutes } = await import("./routes/api");
const { linkRoutes } = await import("./login/link");
const authRoutes = linkRoutes({ requireSignedIn: false });

const sideline = config.app;

// ---- scripted fetch --------------------------------------------------------

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

type Handler = (call: Call) => Response | Promise<Response>;

const realFetch = globalThis.fetch;
let calls: Call[] = [];

function mockFetch(handler: Handler): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: Call = { url: String(input), method: init?.method ?? "GET", headers, body: String(init?.body ?? "") };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function tokenCalls(): Call[] {
  return calls.filter((c) => c.url.endsWith("/oauth/token"));
}

function form(call: Call): URLSearchParams {
  return new URLSearchParams(call.body);
}

function basic(call: Call): string {
  return Buffer.from((call.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString();
}

// A signed-in Sideline user with a linked STX grant.
function linkedUser(appId: string, tokens: { access: string; refresh: string; expiresAt?: number | null }): string {
  const uid = userStore.ensure({ sessionId: `s-${crypto.randomUUID()}`, appId, name: "A", startingWalletCents: 1 }).id;
  linkStore.save({
    userId: uid,
    appId,
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    accessExpiresAt: tokens.expiresAt ?? null,
    scopes: ["balance.read", "orders.write"],
  });
  return uid;
}

beforeEach(() => {
  calls = [];
  db.exec("DELETE FROM users; DELETE FROM account_links; DELETE FROM auth_flows; DELETE FROM activity;");
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---- tests -----------------------------------------------------------------

describe("app profile", () => {
  test("sideline, with its own client credentials", () => {
    expect(sideline.id).toBe("sideline");
    expect(sideline.clientId).toBe("sideline-test-client-id");
    expect(sideline.name).toBe("Sideline");
  });

  test("getApp resolves the app by its id or by default, and nothing else", () => {
    expect(getApp(undefined)).toBe(sideline);
    expect(getApp("sideline")).toBe(sideline);
    expect(getApp("other")).toBeNull();
  });

  test("the SDK OAuth client is built once", () => {
    expect(stxApp(sideline).oauth.clientId).toBe("sideline-test-client-id");
    expect(stxApp(sideline)).toBe(stxApp(sideline));
  });
});

describe("PKCE (RFC 7636 S256)", () => {
  // The canonical RFC 7636 Appendix B vector, also the server's own Pkce
  // doctest, so deriving the same challenge proves the SDK speaks the exact
  // dialect STX verifies against.
  test("codeChallengeS256 matches the RFC 7636 test vector", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await codeChallengeS256(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("generateCodeVerifier is unpadded base64url, unique per call", () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(a).not.toBe(b);
  });
});

describe("authorize redirect", () => {
  test("carries every required param, with the app's own client_id/scope", () => {
    const url = new URL(stxApp(sideline).oauth.buildAuthorizeUrl({ state: "st-123", codeChallenge: "chal-abc" }));
    expect(url.origin + url.pathname).toBe("https://stx.example.com/oauth/authorize");

    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe("sideline-test-client-id");
    expect(p.get("redirect_uri")).toBe("http://localhost:8787/callback");
    expect(p.get("scope")).toBe("profile.read balance.read portfolio.read orders.read orders.write");
    expect(p.get("code_challenge")).toBe("chal-abc");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("state")).toBe("st-123");
  });

  test("beginAuthorization persists the flow in auth_flows; the state is single use", async () => {
    const data = { sessionId: "sess-1", appId: "sideline", userId: "user-9" };
    const auth = await stxApp(sideline).oauth.beginAuthorization(pendingStore, { data });
    const p = new URL(auth.url).searchParams;
    expect(p.get("state")).toBe(auth.state);
    expect(p.get("code_challenge")).toBe(await codeChallengeS256(auth.codeVerifier));

    const cb = await readCallback(pendingStore, { code: "stx_code_1", state: auth.state });
    expect(cb.code).toBe("stx_code_1");
    expect(cb.pending.codeVerifier).toBe(auth.codeVerifier);
    expect(cb.pending.redirectUri).toBe(sideline.redirectUri);
    expect(cb.pending.data).toEqual(data);
    // Consumed: a replay of the same state is refused.
    await expect(readCallback(pendingStore, { code: "stx_code_1", state: auth.state })).rejects.toMatchObject({
      error: "invalid_state",
    });
  });

  test("STX's ?error and a missing code are distinct callback errors", async () => {
    // An error is believed only on a sign-in this app started: the state is checked first.
    const { oauth } = stxApp(sideline);
    const started = await oauth.beginAuthorization(pendingStore, { data: { sessionId: "s", appId: "sideline", userId: "u" } });
    await expect(readCallback(pendingStore, { error: "access_denied", state: started.state })).rejects.toMatchObject({
      error: "access_denied",
    });
    await expect(readCallback(pendingStore, { error: "access_denied", state: "never-issued" })).rejects.toMatchObject({
      error: "invalid_state",
    });
    await expect(readCallback(pendingStore, { state: "x" })).rejects.toMatchObject({ error: expect.stringMatching(/invalid_(request|state)/) });
  });
});

describe("token endpoint requests (per app)", () => {
  test("code exchange: client_secret_basic, PKCE body, tokens stored against the user", async () => {
    mockFetch(() =>
      json(200, {
        access_token: "stx_at_A",
        refresh_token: "stx_rt_A",
        token_type: "bearer",
        expires_in: 3600,
        scope: "balance.read orders.write",
      }),
    );
    const uid = userStore.ensure({ sessionId: "s", appId: "sideline", name: "A", startingWalletCents: 1 }).id;
    const { oauth, tokens } = stxApp(sideline);
    const auth = await oauth.beginAuthorization(pendingStore, { data: { sessionId: "s", appId: "sideline", userId: uid } });
    const cb = await readCallback(pendingStore, { code: "stx_code_XYZ", state: auth.state });
    await oauth.redeemAuthorization(cb, { store: tokens, memberKey: uid });

    const [call] = tokenCalls();
    expect(call!.method).toBe("POST");
    expect(basic(call!)).toBe("sideline-test-client-id:sideline-test-client-secret");
    const body = form(call!);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("stx_code_XYZ");
    expect(body.get("redirect_uri")).toBe("http://localhost:8787/callback");
    expect(body.get("code_verifier")).toBe(auth.codeVerifier);
    // The client is authenticated via HTTP Basic; creds are not in the body.
    expect(body.get("client_id")).toBeNull();
    expect(body.get("client_secret")).toBeNull();

    const link = linkStore.get(uid)!;
    expect(link.appId).toBe("sideline");
    expect(link.accessToken).toBe("stx_at_A");
    expect(link.refreshToken).toBe("stx_rt_A");
    expect(link.scopes).toEqual(["balance.read", "orders.write"]);
    expect(link.accessExpiresAt).toBeGreaterThan(Date.now());
  });

  test("the SDK parses a token response; access_token is required", () => {
    const set = parseTokenResponse({ access_token: "stx_at_AAA", refresh_token: "stx_rt_BBB", expires_in: 3600 });
    expect(set.accessToken).toBe("stx_at_AAA");
    expect(set.refreshToken).toBe("stx_rt_BBB");
    expect(set.expiresAt).toBeGreaterThan(Date.now());
    expect(() => parseTokenResponse({ token_type: "bearer" })).toThrow();
  });
});

describe("member calls: bearer, refresh on 401, rotation", () => {
  test("a 401 refreshes once, persists the rotated pair and retries", async () => {
    const uid = linkedUser("sideline", { access: "stx_at_old", refresh: "stx_rt_old" });
    mockFetch((call) => {
      if (call.url.endsWith("/oauth/token")) {
        return json(200, { access_token: "stx_at_new", refresh_token: "stx_rt_new", expires_in: 3600 });
      }
      return call.headers.authorization === "Bearer stx_at_new"
        ? json(200, { balance: { user_id: "stx-uid", available_balance: "12.00" } })
        : json(401, { error: "invalid_token" });
    });

    const balance = await memberClient(sideline, uid, "Checked STX balance").balance();
    expect(balance.user_id).toBe("stx-uid");

    const [refresh] = tokenCalls();
    expect(basic(refresh!)).toBe("sideline-test-client-id:sideline-test-client-secret");
    expect(form(refresh!).get("grant_type")).toBe("refresh_token");
    expect(form(refresh!).get("refresh_token")).toBe("stx_rt_old");

    const link = linkStore.get(uid)!;
    expect(link.accessToken).toBe("stx_at_new");
    expect(link.refreshToken).toBe("stx_rt_new");

    const log = activityStore.list(10, "sideline").reverse();
    expect(log.map((r) => [r.path, r.status, r.note])).toEqual([
      ["/api/v1/account/balance", 401, "Checked STX balance"],
      ["/oauth/token", 200, "refreshed access token"],
      ["/api/v1/account/balance", 200, "Checked STX balance (retry after token refresh)"],
    ]);
  });

  test("parallel 401s for one user refresh once (a second refresh would read as token reuse)", async () => {
    const uid = linkedUser("sideline", { access: "stx_at_old", refresh: "stx_rt_old" });
    mockFetch(async (call) => {
      if (call.url.endsWith("/oauth/token")) {
        await new Promise((r) => setTimeout(r, 20));
        return json(200, { access_token: "stx_at_new", refresh_token: "stx_rt_new", expires_in: 3600 });
      }
      return call.headers.authorization === "Bearer stx_at_new"
        ? json(200, { orders: [], cursor: null })
        : json(401, { error: "invalid_token" });
    });

    await Promise.all([1, 2, 3].map(() => memberClient(sideline, uid).orders()));
    expect(tokenCalls().length).toBe(1);
    expect(linkStore.get(uid)!.refreshToken).toBe("stx_rt_new");
  });

  test("a refresh STX rejects with invalid_grant unlinks the user", async () => {
    const uid = linkedUser("sideline", { access: "stx_at_old", refresh: "stx_rt_revoked" });
    mockFetch((call) =>
      call.url.endsWith("/oauth/token")
        ? json(400, { error: "invalid_grant", error_description: "revoked" })
        : json(401, { error: "invalid_token" }),
    );

    await expect(memberClient(sideline, uid).balance()).rejects.toBeInstanceOf(STXGrantRevokedException);
    // No stale "linked": the link row is gone, so /api/me reports not connected.
    expect(linkStore.get(uid)).toBeNull();
  });

  test("the socket handshake reads the current token, never one captured earlier", async () => {
    const uid = linkedUser("sideline", { access: "stx_at_1", refresh: "stx_rt_1", expiresAt: Date.now() + 3600_000 });
    const stx = memberClient(sideline, uid);
    expect(await stx.auth!.websocketHeaders!()).toEqual({ "x-stx-oauth-token": "stx_at_1" });
    // Another request rotated the pair meanwhile.
    linkStore.save({
      userId: uid,
      appId: "sideline",
      accessToken: "stx_at_2",
      refreshToken: "stx_rt_2",
      accessExpiresAt: Date.now() + 3600_000,
      scopes: [],
    });
    expect(await stx.auth!.websocketHeaders!()).toEqual({ "x-stx-oauth-token": "stx_at_2" });
  });

  test("a link stored under another app id is not the app's", async () => {
    const uid = linkedUser("other", { access: "stx_at_h", refresh: "stx_rt_h" });
    expect(stxApp(sideline).tokens.get(uid)).toBeNull();
  });

  test("unlink revokes the refresh token at STX and drops the link", async () => {
    const uid = linkedUser("sideline", { access: "stx_at_v", refresh: "stx_rt_v" });
    mockFetch(() => new Response("", { status: 200 }));
    const { oauth, tokens } = stxApp(sideline);
    expect(await oauth.unlink(tokens, uid)).toBe(true);

    const [revoke] = calls;
    expect(revoke!.url).toBe("https://stx.example.com/oauth/revoke");
    expect(basic(revoke!)).toBe("sideline-test-client-id:sideline-test-client-secret");
    expect(form(revoke!).get("token")).toBe("stx_rt_v");
    expect(form(revoke!).get("token_type_hint")).toBe("refresh_token");
    expect(linkStore.get(uid)).toBeNull();
  });
});

describe("app token (client_credentials, market_data)", () => {
  test("minted once and reused, with the app's own client", async () => {
    mockFetch((call) =>
      call.url.endsWith("/oauth/token")
        ? json(200, { access_token: `stx_at_app_${basic(call).split(":")[0]}`, expires_in: 3600 })
        : json(200, { markets: [], cursor: null }),
    );

    // A fresh SDK client with the app's credentials, so no token cached by an
    // earlier test (in any file) hides the mint.
    const app = { ...sideline, id: "mint-test" };
    await stxApp(app).catalog.markets({ status: ["open"], limit: 5 });
    await stxApp(app).catalog.markets({ status: ["open"], limit: 5 });

    const mints = tokenCalls();
    expect(mints.map(basic)).toEqual(["sideline-test-client-id:sideline-test-client-secret"]);
    expect(form(mints[0]!).get("grant_type")).toBe("client_credentials");
    expect(form(mints[0]!).get("scope")).toBe("market_data");

    const reads = calls.filter((c) => c.url.includes("/api/v1/markets"));
    expect(reads.map((c) => c.headers.authorization)).toEqual([
      "Bearer stx_at_app_sideline-test-client-id",
      "Bearer stx_at_app_sideline-test-client-id",
    ]);
    expect(activityStore.list(10, "mint-test").some((r) => r.note === "minted app token")).toBe(true);
  });
});

describe("a dead link reads as not linked", () => {
  function linkedSession(access: string, refresh: string) {
    const sid = `s-${crypto.randomUUID()}`;
    const uid = userStore.ensure({ sessionId: sid, appId: "sideline", name: "A", startingWalletCents: 1 }).id;
    linkStore.save({ userId: uid, appId: "sideline", accessToken: access, refreshToken: refresh, accessExpiresAt: null, scopes: [] });
    return { sid, uid };
  }
  const me = async (sid: string, verify: boolean) =>
    (await (await apiRoutes.request(`/me${verify ? "?verify=1" : ""}`, { headers: { cookie: `isv_sid=${sid}` } })).json()) as {
      link: { connected: boolean };
    };

  test("verify: a grant revoked at STX (refresh refused) is dropped and reported unlinked", async () => {
    const { sid, uid } = linkedSession("stx_at_dead", "stx_rt_revoked");
    mockFetch((call) =>
      call.url.endsWith("/oauth/token")
        ? json(400, { error: "invalid_grant", error_description: "revoked" })
        : json(401, { error: "invalid_token" }),
    );
    expect((await me(sid, false)).link.connected).toBe(true); // the stored row alone says linked
    expect((await me(sid, true)).link.connected).toBe(false);
    expect(linkStore.get(uid)).toBeNull();
  });

  test("an STX account still being verified answers account_pending and keeps the link", async () => {
    const { sid, uid } = linkedSession("stx_at_pending", "stx_rt_pending");
    mockFetch((call) =>
      call.url.endsWith("/oauth/token")
        ? json(400, { error: "invalid_grant", error_reason: "account_pending" })
        : json(401, { error: "invalid_token" }),
    );
    const res = await apiRoutes.request("/balance", { headers: { cookie: `isv_sid=${sid}` } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("account_pending");
    expect(linkStore.get(uid)).not.toBeNull();
  });

  test("verify: a working link stays linked; an STX outage does not unlink", async () => {
    const { sid, uid } = linkedSession("stx_at_ok", "stx_rt_ok");
    mockFetch(() => json(200, { available_balance: "10.0000" }));
    expect((await me(sid, true)).link.connected).toBe(true);
    mockFetch(() => json(503, { error: "unavailable" }));
    expect((await me(sid, true)).link.connected).toBe(true);
    expect(linkStore.get(uid)).not.toBeNull();
  });

  test("/login from a visitor with no Sideline user makes the demo user and goes to STX", async () => {
    const sid = `s-${crypto.randomUUID()}`;
    const res = await authRoutes.request("/login", { headers: { cookie: `isv_sid=${sid}` } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toStartWith("https://stx.example.com/oauth/authorize?");
    // The demo user is made under a session id issued now, not the one sent.
    const issued = (res.headers.get("set-cookie") ?? "").split(";")[0]!.split("=")[1]!;
    expect(issued).not.toBe(sid);
    expect(userStore.find(issued, "sideline")?.name).toBe("Sideline demo user");
    expect(userStore.find(sid, "sideline")).toBeNull();
  });
});
