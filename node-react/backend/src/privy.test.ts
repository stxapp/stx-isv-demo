// The app's own login (Privy) and the STX connect that follows it. Privy itself
// is stubbed (setPrivyVerifier); what is tested is what this app does with a
// verified Privy user: who it signs in, what survives sign-out, and the hints
// it passes to STX.

import { afterEach, describe, expect, test } from "bun:test";

process.env.STX_BASE_URL = "https://stx.example.com";
process.env.CLIENT_ID = "sideline-test-client-id";
process.env.CLIENT_SECRET = "sideline-test-client-secret";
process.env.REDIRECT_URI = "http://localhost:8787/callback";
process.env.OAUTH_SCOPES = "profile.read balance.read portfolio.read orders.read orders.write";
process.env.DB_PATH = ":memory:";

const { setPrivyVerifier } = await import("./privy");
const { linkStore, userStore } = await import("./stores");
const { apiRoutes } = await import("./routes/api");
const { authRoutes, connectHints } = await import("./routes/auth");

afterEach(() => setPrivyVerifier(null));

function privyUser(id: string, extra: { connection?: "google" | "x"; email?: string } = {}) {
  setPrivyVerifier(async (token) => {
    if (token !== `token-${id}`) throw new Error("invalid");
    return { userId: id, name: "Jordan", ...extra };
  });
}

async function privyLogin(sid: string, token: string) {
  return apiRoutes.request("/login/privy", {
    method: "POST",
    headers: { cookie: `isv_sid=${sid}`, "content-type": "application/json" },
    body: JSON.stringify({ accessToken: token }),
  });
}

describe("Privy login", () => {
  test("a verified Privy user is signed in, keyed on the Privy user id, with the STX hint", async () => {
    privyUser("did:privy:a", { connection: "google", email: "jordan@example.com" });
    const sid = `s-${crypto.randomUUID()}`;
    const res = await privyLogin(sid, "token-did:privy:a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connectHint: { connection: string; loginHint: string } };
    expect(body.connectHint).toEqual({ connection: "google", loginHint: "jordan@example.com" });
    expect(userStore.find(sid, "sideline")?.externalId).toBe("did:privy:a");
  });

  test("an invalid token is refused and signs nobody in", async () => {
    privyUser("did:privy:b");
    const sid = `s-${crypto.randomUUID()}`;
    expect((await privyLogin(sid, "forged")).status).toBe(401);
    expect(userStore.find(sid, "sideline")).toBeNull();
  });

  test("the mock sign-in is off while Privy is the login", async () => {
    privyUser("did:privy:c");
    const res = await apiRoutes.request("/login", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });

  test("a returning user on another browser gets the same user and STX link back", async () => {
    privyUser("did:privy:d");
    const first = `s-${crypto.randomUUID()}`;
    await privyLogin(first, "token-did:privy:d");
    const uid = userStore.find(first, "sideline")!.id;
    linkStore.save({ userId: uid, appId: "sideline", accessToken: "at", refreshToken: "rt", accessExpiresAt: null, scopes: [] });

    const second = `s-${crypto.randomUUID()}`;
    await privyLogin(second, "token-did:privy:d");
    expect(userStore.find(second, "sideline")?.id).toBe(uid);
    expect(userStore.find(first, "sideline")).toBeNull();
    expect(linkStore.get(uid)?.accessToken).toBe("at");
  });

  test("signing out keeps the user and their STX link for the next sign-in", async () => {
    privyUser("did:privy:e");
    const sid = `s-${crypto.randomUUID()}`;
    await privyLogin(sid, "token-did:privy:e");
    const uid = userStore.find(sid, "sideline")!.id;
    linkStore.save({ userId: uid, appId: "sideline", accessToken: "at", refreshToken: "rt", accessExpiresAt: null, scopes: [] });

    await apiRoutes.request("/signout", { method: "POST", headers: { cookie: `isv_sid=${sid}` } });
    expect(userStore.find(sid, "sideline")).toBeNull();
    expect(userStore.get(uid)).not.toBeNull();
    expect(linkStore.get(uid)).not.toBeNull();

    await privyLogin(sid, "token-did:privy:e");
    expect(userStore.find(sid, "sideline")?.id).toBe(uid);
  });
});

describe("signed-out users and earlier visitors", () => {
  test("a signed-out user cannot be signed back in by a cookie built from what the browser knew", async () => {
    privyUser("did:privy:out");
    const sid = `s-${crypto.randomUUID()}`;
    await privyLogin(sid, "token-did:privy:out");
    const user = userStore.find(sid, "sideline")!;
    await apiRoutes.request("/signout", { method: "POST", headers: { cookie: `isv_sid=${sid}` } });

    const held = userStore.get(user.id)!.sessionId;
    expect(held).not.toContain(user.id);
    for (const cookie of [`detached:${user.id}`, held]) {
      const res = await apiRoutes.request("/me", { headers: { cookie: `isv_sid=${cookie}` } });
      expect(((await res.json()) as { user: unknown }).user).toBeNull();
    }
  });

  test("a first sign-in does not take over a mock user on the browser, or its STX link", async () => {
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
    try {
      await privyLogin(sid, "token-did:privy:new");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(revoked).toEqual(["their-rt"]);
    const user = userStore.find(sid, "sideline")!;
    expect(user.id).not.toBe(mock.id);
    expect(linkStore.get(user.id)).toBeNull();
    expect(userStore.get(mock.id)).toBeNull();
    expect(linkStore.get(mock.id)).toBeNull();
  });
});

describe("the page that ends linking", () => {
  test("text from the callback's query stays data in the page's script", async () => {
    const text = encodeURIComponent("</script><b>&");
    const page = await (await authRoutes.request(`/callback?error=${text}`)).text();
    expect(page.match(/<script>/g)).toHaveLength(1);
    expect(page.match(/<\/script>/g)).toHaveLength(1);
    expect(page).not.toContain("<b>");
    expect(page).toContain("\\u003c/script\\u003e\\u003cb\\u003e\\u0026");
  });
});

describe("STX connect after Privy", () => {
  test("connecting needs a signed-in user", async () => {
    privyUser("did:privy:f");
    const res = await authRoutes.request("/login", { headers: { cookie: `isv_sid=s-${crypto.randomUUID()}` } });
    expect(await res.text()).toContain("not_signed_in");
  });

  test("the Privy hint goes to STX's authorize as connection and login_hint", async () => {
    privyUser("did:privy:g", { connection: "google", email: "jordan@example.com" });
    const sid = `s-${crypto.randomUUID()}`;
    await privyLogin(sid, "token-did:privy:g");
    const res = await authRoutes.request("/login?connection=google&login_hint=jordan%40example.com", {
      headers: { cookie: `isv_sid=${sid}` },
    });
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location")!);
    expect(url.searchParams.get("connection")).toBe("google");
    expect(url.searchParams.get("login_hint")).toBe("jordan@example.com");
  });

  test("hints are validated: unknown providers and non-emails are dropped", () => {
    expect(connectHints("facebook", "not an email")).toEqual({});
    expect(connectHints("x", "a@b.co")).toEqual({ connection: "x", login_hint: "a@b.co" });
    expect(connectHints(undefined, undefined)).toEqual({});
  });
});
