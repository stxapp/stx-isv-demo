// Login mode `stx`, against a mock STX (test-support/mockStx.ts): a local
// server with the published sign-in configuration, signing keys and a token
// endpoint that mints a signed ID token. The person's login at STX is the one
// mocked step. Covers the redirect to STX, the state, session and nonce
// checks, and a returning member landing on the same account.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startMockStx, type MockStx } from "../../../test-support/mockStx";

// Same env block as the other test files: `config` is one shared singleton.
process.env.STX_BASE_URL = "https://stx.example.com";
process.env.CLIENT_ID = "sideline-test-client-id";
process.env.CLIENT_SECRET = "sideline-test-client-secret";
process.env.REDIRECT_URI = "http://localhost:8787/callback";
process.env.OAUTH_SCOPES = "profile.read balance.read portfolio.read orders.read orders.write";
process.env.DB_PATH = ":memory:";

const { Hono } = await import("hono");
const { config } = await import("../../config");
const { linkStore, userStore } = await import("../../stores");
const { apiRoutes } = await import("../../routes/api");
const { resetStxConnect, stxLoginRoutes } = await import("./index");

const REDIRECT = "http://localhost:8787/auth/stx/callback";
let stx: MockStx;

beforeAll(async () => {
  stx = await startMockStx({
    clients: [{ clientId: config.app.clientId, clientSecret: config.app.clientSecret, redirectUris: [REDIRECT] }],
  });
  const login = config.stxLogin as { issuer: string; redirectUri: string };
  login.issuer = stx.url;
  login.redirectUri = REDIRECT;
  resetStxConnect();
});

afterAll(() => {
  stx.stop();
  resetStxConnect();
});

// The app as index.ts builds it in this mode.
const app = new Hono().route("/", stxLoginRoutes()).route("/api", apiRoutes);

function cookieFrom(res: Response): string {
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}
const sidOf = (cookie: string) => cookie.split("=")[1]!;

// Start a sign-in; returns the URL at STX and the session cookie.
async function start(cookie?: string, query = "") {
  const res = await app.request(`/auth/stx/start${query ? `?${query}` : ""}`, { headers: cookie ? { cookie } : {} });
  expect(res.status).toBe(302);
  return { authorize: new URL(res.headers.get("location")!), cookie: cookie ?? cookieFrom(res) };
}

// What the person's browser does next: go to STX, come back with a code.
async function throughStx(authorize: URL): Promise<string> {
  const res = await fetch(authorize, { redirect: "manual" });
  expect(res.status).toBe(302);
  const back = new URL(res.headers.get("location")!);
  return back.pathname + back.search;
}

async function signIn(member: { sub: string; email: string; name?: string }, cookie?: string) {
  const started = await start(cookie);
  stx.member = member;
  const res = await app.request(await throughStx(started.authorize), { headers: { cookie: started.cookie } });
  // Signing in gives the browser a new session cookie.
  const signedIn = cookieFrom(res) || started.cookie;
  return { page: await res.text(), cookie: signedIn, sid: sidOf(signedIn), before: started.cookie };
}

describe("login mode stx", () => {
  test("start sends the browser to STX with PKCE, state, nonce, openid and the hints", async () => {
    const { authorize } = await start(undefined, "connection=google&login_hint=jordan%40example.com");
    expect(authorize.origin + authorize.pathname).toBe(`${stx.url}/oauth/authorize`);
    const p = authorize.searchParams;
    expect(p.get("client_id")).toBe(config.app.clientId);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("redirect_uri")).toBe(REDIRECT);
    expect(p.get("scope")?.split(" ")).toContain("openid");
    expect(p.get("scope")?.split(" ")).toContain("orders.write");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toBeTruthy();
    expect(p.get("state")).toBeTruthy();
    expect(p.get("nonce")).toBeTruthy();
    expect(p.get("connection")).toBe("google");
    expect(p.get("login_hint")).toBe("jordan@example.com");
  });

  test("with no connection the person lands on STX's own page to register or log in", async () => {
    const { authorize } = await start();
    expect(authorize.searchParams.has("connection")).toBe(false);
  });

  test("an unknown connection is not passed on", async () => {
    const { authorize } = await start(undefined, "connection=myspace");
    expect(authorize.searchParams.has("connection")).toBe(false);
  });

  test("a valid login creates the user on the STX member id and stores the tokens server-side", async () => {
    const { page, sid } = await signIn({ sub: "member-42", email: "jordan@example.com" });
    expect(page).toContain('"status":"linked"');

    // The code exchange proved PKCE to STX.
    const exchange = stx.requests.filter((r) => r.path === "/oauth/token").at(-1)!;
    expect(exchange.form.get("grant_type")).toBe("authorization_code");
    expect(exchange.form.get("code_verifier")).toBeTruthy();

    const user = userStore.find(sid, config.app.id)!;
    expect(user.externalId).toBe(`stx:${stx.url}|member-42`);
    expect(user.email).toBe("jordan@example.com");
    expect(user.name).toBe("jordan");
    const link = linkStore.get(user.id)!;
    expect(link.accessToken).toStartWith("mock_at_");
    expect(link.refreshToken).toStartWith("mock_rt_");
    expect(link.scopes).toContain("orders.write");
    // Nothing secret reaches the browser.
    expect(page).not.toContain(link.accessToken);
    expect(page).not.toContain(link.refreshToken!);
  });

  test("the logged-in member is signed in to the app and linked in one step", async () => {
    const { cookie } = await signIn({ sub: "member-me", email: "me@example.com", name: "Morgan Lee" });
    const me = (await (await app.request("/api/me", { headers: { cookie } })).json()) as {
      user: { name: string; email: string };
      link: { connected: boolean };
    };
    expect(me.user).toMatchObject({ name: "Morgan Lee", email: "me@example.com" });
    expect(me.link.connected).toBe(true);
  });

  test("signing in moves the browser to a new session id; the one it arrived with is signed in to nothing", async () => {
    // A cookie someone else planted in this browser before the login.
    const planted = "isv_sid=planted-by-someone-else";
    const { cookie, sid, before } = await signIn({ sub: "member-fix", email: "fix@example.com" }, planted);
    expect(before).toBe(planted);
    expect(cookie).not.toBe(planted);
    expect(userStore.find(sid, config.app.id)?.externalId).toBe(`stx:${stx.url}|member-fix`);
    expect(userStore.find("planted-by-someone-else", config.app.id)).toBeNull();
    const me = (await (await app.request("/api/me", { headers: { cookie: planted } })).json()) as { user: unknown };
    expect(me.user).toBeNull();
  });

  test("a callback with a state this app never issued is refused", async () => {
    const { cookie } = await start();
    const before = stx.requests.length;
    const page = await (await app.request("/auth/stx/callback?code=x&state=not-a-real-state", { headers: { cookie } })).text();
    expect(page).toContain("invalid_state");
    expect(stx.requests.length).toBe(before);
  });

  test("a callback in another browser session is refused", async () => {
    const mine = await start();
    const other = await start();
    const back = await throughStx(mine.authorize);
    const before = stx.requests.length;
    const page = await (await app.request(back, { headers: { cookie: other.cookie } })).text();
    expect(page).toContain("session_mismatch");
    expect(stx.requests.length).toBe(before);
  });

  test("an ID token with the wrong nonce is refused and nobody is signed in", async () => {
    const started = await start();
    stx.member = { sub: "member-bad-nonce", email: "x@example.com" };
    stx.forceNonce = "someone-elses-nonce";
    const page = await (await app.request(await throughStx(started.authorize), { headers: { cookie: started.cookie } })).text();
    expect(page).toContain("sign_in_failed");
    expect(userStore.find(sidOf(started.cookie), config.app.id)).toBeNull();
  });

  test("text from the callback's query cannot break out of the result page's script", async () => {
    const { authorize, cookie } = await start();
    const attack = encodeURIComponent('</script><script>alert(1)</script>');
    const state = authorize.searchParams.get("state")!;
    const page = await (await app.request(`/auth/stx/callback?error=${attack}&state=${state}`, { headers: { cookie } })).text();
    expect(page).not.toContain("</script><script>alert(1)");
    expect(page.match(/<script>/g)).toHaveLength(1);
    // The text still arrives intact as data.
    expect(page).toContain("\\u003c/script\\u003e");
  });

  test("an error is believed only on a sign-in this browser started", async () => {
    const mine = await start();
    const other = await start();
    const state = mine.authorize.searchParams.get("state")!;
    // No such sign-in: the error text is not passed on.
    const unknown = await (await app.request("/auth/stx/callback?error=access_denied&state=nope", { headers: { cookie: mine.cookie } })).text();
    expect(unknown).toContain("invalid_state");
    expect(unknown).not.toContain("access_denied");
    // Another browser's session: refused the same way a code would be.
    const wrong = await (await app.request(`/auth/stx/callback?error=access_denied&state=${state}`, { headers: { cookie: other.cookie } })).text();
    expect(wrong).toContain("session_mismatch");
  });

  test("a state is single use", async () => {
    const started = await start();
    stx.member = { sub: "member-once", email: "once@example.com" };
    const back = await throughStx(started.authorize);
    expect(await (await app.request(back, { headers: { cookie: started.cookie } })).text()).toContain('"status":"linked"');
    expect(await (await app.request(back, { headers: { cookie: started.cookie } })).text()).toContain("invalid_state");
  });

  test("cancelling at STX comes back as access_denied and the sign-in is dropped", async () => {
    const started = await start();
    stx.deny = true;
    const back = await throughStx(started.authorize);
    expect(back).toContain("error=access_denied");
    const page = await (await app.request(back, { headers: { cookie: started.cookie } })).text();
    expect(page).toContain("access_denied");
    expect(userStore.find(sidOf(started.cookie), config.app.id)).toBeNull();
    // The state was consumed with the error.
    const state = started.authorize.searchParams.get("state")!;
    const again = await (await app.request(`/auth/stx/callback?code=x&state=${state}`, { headers: { cookie: started.cookie } })).text();
    expect(again).toContain("invalid_state");
  });

  test("signing out keeps the account; the same member in a new browser lands on it again", async () => {
    const first = await signIn({ sub: "member-77", email: "sam@example.com" });
    const original = userStore.find(first.sid, config.app.id)!;

    const out = await app.request("/api/signout", { method: "POST", headers: { cookie: first.cookie } });
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(userStore.find(first.sid, config.app.id)).toBeNull();
    expect(userStore.get(original.id)).not.toBeNull();

    const again = await signIn({ sub: "member-77", email: "sam@example.com" });
    expect(again.sid).not.toBe(first.sid);
    expect(userStore.find(again.sid, config.app.id)!.id).toBe(original.id);
  });

  test("a signed-out member cannot be signed back in by a cookie built from their user id", async () => {
    const { cookie, sid } = await signIn({ sub: "member-out", email: "out@example.com" });
    const user = userStore.find(sid, config.app.id)!;
    await app.request("/api/signout", { method: "POST", headers: { cookie } });

    // What the store now holds for them is not derived from anything the browser knew...
    const held = userStore.get(user.id)!.sessionId;
    expect(held).toStartWith("detached:");
    expect(held).not.toContain(user.id);
    // ...and neither the old guessable form nor the real placeholder works as a cookie.
    for (const forged of [`detached:${user.id}`, held]) {
      const me = (await (await app.request("/api/me", { headers: { cookie: `isv_sid=${forged}` } })).json()) as { user: unknown };
      expect(me.user).toBeNull();
    }
  });

  test("the same member id at a different exchange is a different user", async () => {
    const here = await signIn({ sub: "member-same", email: "same@example.com" });
    const first = userStore.find(here.sid, config.app.id)!;

    // The app is pointed at another exchange, which happens to use the same id.
    const other = await startMockStx({
      clients: [{ clientId: config.app.clientId, clientSecret: config.app.clientSecret, redirectUris: [REDIRECT] }],
    });
    const login = config.stxLogin as { issuer: string };
    const original = login.issuer;
    try {
      login.issuer = other.url;
      resetStxConnect();
      const started = await start();
      other.member = { sub: "member-same", email: "someone-else@example.com" };
      const back = await fetch(started.authorize, { redirect: "manual" });
      const url = new URL(back.headers.get("location")!);
      const res = await app.request(url.pathname + url.search, { headers: { cookie: started.cookie } });
      const there = userStore.find(sidOf(cookieFrom(res)), config.app.id)!;
      expect(there.id).not.toBe(first.id);
      expect(linkStore.get(first.id)?.accessToken).not.toBe(linkStore.get(there.id)?.accessToken);
    } finally {
      login.issuer = original;
      resetStxConnect();
      other.stop();
    }
  });

  test("a Playbook database's users are carried over to the key this mode uses", async () => {
    const { db, adoptPlaybookUsers } = await import("../../db");
    expect(adoptPlaybookUsers(stx.url)).toBe(0); // no such column: nothing to do
    db.exec(`ALTER TABLE users ADD COLUMN stx_sub TEXT`);
    try {
      const sid = `s-${crypto.randomUUID()}`;
      const old = userStore.ensure({ sessionId: sid, appId: config.app.id, name: "From Playbook", startingWalletCents: 777 });
      db.query(`UPDATE users SET stx_sub = 'member-old', session_id = 'signed-out:x' WHERE id = $id`).run({ $id: old.id });
      // A second row with the same member id, as an old database could hold.
      const twin = userStore.ensure({ sessionId: `s-${crypto.randomUUID()}`, appId: config.app.id, name: "Twin", startingWalletCents: 1 });
      db.query(`UPDATE users SET stx_sub = 'member-old' WHERE id = $id`).run({ $id: twin.id });
      // The earlier row gets the key; the twin is left alone and nothing throws.
      expect(adoptPlaybookUsers(stx.url)).toBe(1);
      expect(userStore.get(old.id)?.externalId).toBe(`stx:${stx.url}|member-old`);
      expect(userStore.get(twin.id)?.externalId).toBeNull();

      const { sid: now } = await signIn({ sub: "member-old", email: "old@example.com" });
      const user = userStore.find(now, config.app.id)!;
      expect(user.id).toBe(old.id);
      expect(user.walletCents).toBe(777);
    } finally {
      db.exec(`ALTER TABLE users DROP COLUMN stx_sub`);
    }
  });

  test("a mock user left on the browser is retired, and its STX link revoked, before the member is signed in", async () => {
    // A mock user with a link, as an earlier own-mode deployment would have left.
    const started = await start();
    const sid = sidOf(started.cookie);
    const mock = userStore.ensure({ sessionId: sid, appId: config.app.id, name: "Earlier visitor", startingWalletCents: 1 });
    linkStore.save({ userId: mock.id, appId: config.app.id, accessToken: "their-at", refreshToken: "their-rt", accessExpiresAt: null, scopes: [] });

    // The link's revoke goes to the exchange in STX_BASE_URL; everything else is the mock.
    const revoked: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "https://stx.example.com/oauth/revoke") {
        revoked.push(new URLSearchParams(String(init?.body)).get("token") ?? "");
        return new Response("", { status: 200 });
      }
      return realFetch(input as string, init);
    }) as unknown as typeof fetch;
    try {
      stx.member = { sub: "member-after-mock", email: "after@example.com" };
      const res = await app.request(await throughStx(started.authorize), { headers: { cookie: started.cookie } });
      const user = userStore.find(sidOf(cookieFrom(res)), config.app.id)!;
      expect(user.id).not.toBe(mock.id);
      expect(linkStore.get(user.id)?.accessToken).toStartWith("mock_at_");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(revoked).toEqual(["their-rt"]);
    expect(userStore.get(mock.id)).toBeNull();
    expect(linkStore.get(mock.id)).toBeNull();
  });

  test("when another member signs in on the same browser, the first member's live streams are ended", async () => {
    const liveProxy = await import("../../liveProxy");
    const a = await signIn({ sub: "member-stream-a", email: "sa@example.com" });
    const first = userStore.find(a.sid, config.app.id)!;
    const closed: string[] = [];
    const { mock: fnMock } = await import("bun:test");
    const original = liveProxy.closeLiveFeed;
    await fnMock.module("../../liveProxy", () => ({
      ...liveProxy,
      closeLiveFeed: async (_app: unknown, userId: string) => void closed.push(userId),
    }));
    try {
      const b = await signIn({ sub: "member-stream-b", email: "sb@example.com" }, a.cookie);
      const second = userStore.find(b.sid, config.app.id)!;
      // The member leaving the browser, then the one arriving (streams from other browsers).
      expect(closed).toEqual([first.id, second.id]);
    } finally {
      await fnMock.module("../../liveProxy", () => ({ ...liveProxy, closeLiveFeed: original }));
    }
  });

  test("a different member on the same browser gets their own account", async () => {
    const a = await signIn({ sub: "member-a", email: "a@example.com" });
    const first = userStore.find(a.sid, config.app.id)!;
    const b = await signIn({ sub: "member-b", email: "b@example.com" }, a.cookie);
    const second = userStore.find(b.sid, config.app.id)!;
    // The first member is no longer on any browser session.
    expect(userStore.find(a.sid, config.app.id)).toBeNull();
    expect(second.id).not.toBe(first.id);
    expect(second.externalId).toBe(`stx:${stx.url}|member-b`);
    // The first member's account and link are kept for their next login.
    expect(linkStore.get(first.id)).not.toBeNull();
  });

  test("this mode has no login of the app's own and no separate link step", async () => {
    expect((await app.request("/api/login", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await app.request("/api/login/privy", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await app.request("/login")).status).toBe(404);
    expect((await app.request("/auth/vendor/start")).status).toBe(404);
  });
});
