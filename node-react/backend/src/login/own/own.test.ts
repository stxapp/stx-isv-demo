// Login mode `own`: the app's own login (Privy, or the mock) and the STX link
// that follows it. Privy itself is stubbed (setPrivyVerifier); what is tested
// is what this app does with a verified user: who it signs in, what survives
// sign-out, and the hints it passes to STX.

import { afterEach, describe, expect, test } from "bun:test";

process.env.STX_BASE_URL = "https://stx.example.com";
process.env.CLIENT_ID = "sideline-test-client-id";
process.env.CLIENT_SECRET = "sideline-test-client-secret";
process.env.REDIRECT_URI = "http://localhost:8787/callback";
process.env.OAUTH_SCOPES = "profile.read balance.read portfolio.read orders.read orders.write";
process.env.DB_PATH = ":memory:";

const { Hono } = await import("hono");
const { setPrivyVerifier } = await import("./privy");
const { linkStore, userStore } = await import("../../stores");
const { apiRoutes } = await import("../../routes/api");
const { connectHints } = await import("../shared");
const { ownLoginRoutes } = await import("./index");

// The app as index.ts builds it, once per own login.
function appFor(which: "privy" | "mock") {
  return new Hono().route("/", ownLoginRoutes(which)).route("/api", apiRoutes);
}
const privyApp = appFor("privy");
const mockApp = appFor("mock");

afterEach(() => setPrivyVerifier(null));

function privyUser(id: string, extra: { connection?: "google" | "x"; email?: string } = {}) {
  setPrivyVerifier(async (token) => {
    if (token !== `token-${id}`) throw new Error("invalid");
    return { userId: id, name: "Jordan", ...extra };
  });
}

// Signing in gives the browser a new session id; `sid` is that new one (or the
// one sent, when the login was refused).
async function privyLogin(sentSid: string, token: string) {
  const res = await privyApp.request("/api/login/privy", {
    method: "POST",
    headers: { cookie: `isv_sid=${sentSid}`, "content-type": "application/json" },
    body: JSON.stringify({ accessToken: token }),
  });
  const set = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return Object.assign(res, { sid: set ? set.split("=")[1]! : sentSid });
}

describe("Privy login", () => {
  test("a verified Privy user is signed in, keyed on the Privy user id, with the STX hint", async () => {
    privyUser("did:privy:a", { connection: "google", email: "jordan@example.com" });
    const res = await privyLogin(`s-${crypto.randomUUID()}`, "token-did:privy:a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connectHint: { connection: string; loginHint: string } };
    expect(body.connectHint).toEqual({ connection: "google", loginHint: "jordan@example.com" });
    expect(userStore.find(res.sid, "sideline")?.externalId).toBe("did:privy:a");
  });

  test("signing in moves the browser to a new session id; the one it arrived with is signed in to nothing", async () => {
    privyUser("did:privy:fix");
    const res = await privyLogin("planted-by-someone-else", "token-did:privy:fix");
    expect(res.sid).not.toBe("planted-by-someone-else");
    expect(userStore.find(res.sid, "sideline")?.externalId).toBe("did:privy:fix");
    expect(userStore.find("planted-by-someone-else", "sideline")).toBeNull();
  });

  test("an invalid token is refused and signs nobody in", async () => {
    privyUser("did:privy:b");
    const sid = `s-${crypto.randomUUID()}`;
    expect((await privyLogin(sid, "forged")).status).toBe(401);
    expect(userStore.find(sid, "sideline")).toBeNull();
  });

  test("the mock sign-in is off while Privy is the login", async () => {
    privyUser("did:privy:c");
    const res = await privyApp.request("/api/login", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });

  test("the user's email is kept and shown", async () => {
    privyUser("did:privy:mail", { email: "mail@example.com" });
    const { sid } = await privyLogin(`s-${crypto.randomUUID()}`, "token-did:privy:mail");
    const me = (await (await privyApp.request("/api/me", { headers: { cookie: `isv_sid=${sid}` } })).json()) as {
      user: { email: string };
    };
    expect(me.user.email).toBe("mail@example.com");
  });

  test("a returning user on another browser gets the same user and STX link back", async () => {
    privyUser("did:privy:d");
    const { sid: first } = await privyLogin(`s-${crypto.randomUUID()}`, "token-did:privy:d");
    const uid = userStore.find(first, "sideline")!.id;
    linkStore.save({ userId: uid, appId: "sideline", accessToken: "at", refreshToken: "rt", accessExpiresAt: null, scopes: [] });

    const { sid: second } = await privyLogin(`s-${crypto.randomUUID()}`, "token-did:privy:d");
    expect(userStore.find(second, "sideline")?.id).toBe(uid);
    expect(userStore.find(first, "sideline")).toBeNull();
    expect(linkStore.get(uid)?.accessToken).toBe("at");
  });

  test("signing out keeps the user and their STX link for the next sign-in", async () => {
    privyUser("did:privy:e");
    const { sid } = await privyLogin(`s-${crypto.randomUUID()}`, "token-did:privy:e");
    const uid = userStore.find(sid, "sideline")!.id;
    linkStore.save({ userId: uid, appId: "sideline", accessToken: "at", refreshToken: "rt", accessExpiresAt: null, scopes: [] });

    await privyApp.request("/api/signout", { method: "POST", headers: { cookie: `isv_sid=${sid}` } });
    expect(userStore.find(sid, "sideline")).toBeNull();
    expect(userStore.get(uid)).not.toBeNull();
    expect(linkStore.get(uid)).not.toBeNull();

    const again = await privyLogin(sid, "token-did:privy:e");
    expect(userStore.find(again.sid, "sideline")?.id).toBe(uid);
  });
});

describe("a returning user", () => {
  test("their name follows what the login says now", async () => {
    privyUser("did:privy:renamed");
    const first = await privyLogin(`s-${crypto.randomUUID()}`, "token-did:privy:renamed");
    expect(userStore.find(first.sid, "sideline")?.name).toBe("Jordan");
    setPrivyVerifier(async () => ({ userId: "did:privy:renamed", name: "Jordan Park" }));
    const again = await privyLogin(first.sid, "anything");
    expect(userStore.find(again.sid, "sideline")?.name).toBe("Jordan Park");
  });
});

describe("a mock user already on the browser", () => {
  test("a first Privy sign-in does not take over the mock user or its STX link", async () => {
    // Someone used this browser with the mock login and linked an STX account.
    const sid = `s-${crypto.randomUUID()}`;
    const mock = userStore.ensure({ sessionId: sid, appId: "sideline", name: "Earlier visitor", startingWalletCents: 1 });
    linkStore.save({ userId: mock.id, appId: "sideline", accessToken: "their-at", refreshToken: "their-rt", accessExpiresAt: null, scopes: [] });

    // The earlier visitor's link is ended at STX, not just forgotten here.
    const revoked: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/oauth/revoke")) revoked.push(new URLSearchParams(String(init?.body)).get("token") ?? "");
      return new Response("", { status: 200 });
    }) as typeof fetch;
    privyUser("did:privy:new");
    let res: Awaited<ReturnType<typeof privyLogin>>;
    try {
      res = await privyLogin(sid, "token-did:privy:new");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(revoked).toEqual(["their-rt"]);
    const user = userStore.find(res.sid, "sideline")!;
    expect(user.id).not.toBe(mock.id);
    expect(linkStore.get(user.id)).toBeNull();
    // The earlier visitor's user and tokens are gone, not handed over.
    expect(userStore.get(mock.id)).toBeNull();
    expect(linkStore.get(mock.id)).toBeNull();
  });
});

describe("linking STX after Privy", () => {
  test("connecting needs a signed-in user", async () => {
    privyUser("did:privy:f");
    const res = await privyApp.request("/login", { headers: { cookie: `isv_sid=s-${crypto.randomUUID()}` } });
    expect(await res.text()).toContain("not_signed_in");
  });

  test("the Privy hint goes to STX's authorize as connection and login_hint", async () => {
    privyUser("did:privy:g", { connection: "google", email: "jordan@example.com" });
    const { sid } = await privyLogin(`s-${crypto.randomUUID()}`, "token-did:privy:g");
    const res = await privyApp.request("/login?connection=google&login_hint=jordan%40example.com", {
      headers: { cookie: `isv_sid=${sid}` },
    });
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location")!);
    expect(url.searchParams.get("connection")).toBe("google");
    expect(url.searchParams.get("login_hint")).toBe("jordan@example.com");
  });

  test("hints are validated: unknown providers and non-emails are dropped", () => {
    expect(connectHints("facebook", "not an email")).toEqual({});
    expect(connectHints("x", "a@b.co")).toEqual({ connection: "x", loginHint: "a@b.co" });
    expect(connectHints(undefined, undefined)).toEqual({});
  });
});

describe("mock login", () => {
  // Signing in gives the browser a new session id; `sid` is that new one.
  async function mockLogin(sentSid: string, name?: string) {
    const res = await mockApp.request("/api/login", {
      method: "POST",
      headers: { cookie: `isv_sid=${sentSid}`, "content-type": "application/json" },
      body: JSON.stringify(name ? { name } : {}),
    });
    const set = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    return Object.assign(res, { sid: set ? set.split("=")[1]! : sentSid });
  }

  test("signs in a demo user with a wallet and no account behind it", async () => {
    const res = await mockLogin(`s-${crypto.randomUUID()}`, "Riley");
    expect(res.status).toBe(200);
    const user = userStore.find(res.sid, "sideline")!;
    expect(user.name).toBe("Riley");
    expect(user.externalId).toBeNull();
    expect(user.walletCents).toBeGreaterThan(0);
  });

  test("signing in moves the browser to a new session id; the one it arrived with is signed in to nothing", async () => {
    const res = await mockLogin("planted-by-someone-else");
    expect(res.sid).not.toBe("planted-by-someone-else");
    expect(userStore.find(res.sid, "sideline")).not.toBeNull();
    expect(userStore.find("planted-by-someone-else", "sideline")).toBeNull();
  });

  test("the Privy route is off while the mock is the login", async () => {
    const res = await mockApp.request("/api/login/privy", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });

  test("linking works before signing in: the visitor gets the demo user, under a session id issued then", async () => {
    const sid = `s-${crypto.randomUUID()}`;
    const res = await mockApp.request("/login", { headers: { cookie: `isv_sid=${sid}` } });
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location")!);
    expect(url.pathname).toBe("/oauth/authorize");
    // Linking asks for the trading scopes only: no ID token is needed.
    expect(url.searchParams.get("scope")).not.toContain("openid");
    const issued = (res.headers.get("set-cookie") ?? "").split(";")[0]!.split("=")[1]!;
    expect(issued).not.toBe(sid);
    expect(userStore.find(issued, "sideline")).not.toBeNull();
    expect(userStore.find(sid, "sideline")).toBeNull();
  });

  test("a link is not made if the browser is no longer signed in as the user who started it", async () => {
    const { sid } = await mockLogin(`s-${crypto.randomUUID()}`);
    const uid = userStore.find(sid, "sideline")!.id;
    const start = await mockApp.request("/login", { headers: { cookie: `isv_sid=${sid}` } });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;

    // The STX window comes back to a browser that now holds another session.
    const realFetch = globalThis.fetch;
    let exchanged = 0;
    globalThis.fetch = (async () => {
      exchanged++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const page = await (
        await mockApp.request(`/callback?code=c&state=${state}`, { headers: { cookie: `isv_sid=s-${crypto.randomUUID()}` } })
      ).text();
      expect(page).toContain("session_mismatch");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(exchanged).toBe(0);
    expect(linkStore.get(uid)).toBeNull();
  });

  test("signing out removes the mock user entirely", async () => {
    const { sid } = await mockLogin(`s-${crypto.randomUUID()}`);
    const uid = userStore.find(sid, "sideline")!.id;
    await mockApp.request("/api/signout", { method: "POST", headers: { cookie: `isv_sid=${sid}` } });
    expect(userStore.get(uid)).toBeNull();
  });
});
