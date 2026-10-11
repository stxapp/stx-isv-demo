// Login mode `vendor`, against two local servers (test-support/mockStx.ts):
// one plays the login service, the other plays STX. Both are generic OpenID
// Connect servers; no real login service is involved, and the person's login
// at each is the mocked step. Covers the redirect to the service, the state,
// session and nonce checks, who gets signed in, and the STX link that follows.

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
const { resetVendorConfiguration, vendorLoginRoutes, vendorSignOutUrl } = await import("./index");

const VENDOR_REDIRECT = "http://localhost:8787/auth/vendor/callback";
let service: MockStx;

beforeAll(async () => {
  service = await startMockStx({
    clients: [{ clientId: "app-at-the-service", clientSecret: "service-secret", redirectUris: [VENDOR_REDIRECT] }],
  });
  Object.assign(config.vendor, {
    name: "Example Login",
    issuer: service.url,
    clientId: "app-at-the-service",
    clientSecret: "service-secret",
    redirectUri: VENDOR_REDIRECT,
    authorizeParams: "connection=stx&state=attacker&nonce=attacker",
    allowInsecure: true,
  });
  resetVendorConfiguration();
});

afterAll(() => {
  service.stop();
  resetVendorConfiguration();
});

// The app as index.ts builds it in this mode.
const app = new Hono().route("/", vendorLoginRoutes()).route("/api", apiRoutes);

function cookieFrom(res: Response): string {
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}
const sidOf = (cookie: string) => cookie.split("=")[1]!;

async function start(cookie?: string) {
  const res = await app.request("/auth/vendor/start", { headers: cookie ? { cookie } : {} });
  expect(res.status).toBe(302);
  return { authorize: new URL(res.headers.get("location")!), cookie: cookie ?? cookieFrom(res) };
}

// What the person's browser does next: go to the service, come back with a code.
async function throughService(authorize: URL): Promise<string> {
  const res = await fetch(authorize, { redirect: "manual" });
  expect(res.status).toBe(302);
  const back = new URL(res.headers.get("location")!);
  return back.pathname + back.search;
}

async function signIn(member: { sub: string; email: string; name?: string }, cookie?: string) {
  const started = await start(cookie);
  service.member = member;
  const res = await app.request(await throughService(started.authorize), { headers: { cookie: started.cookie } });
  // Signing in gives the browser a new session cookie.
  const signedIn = cookieFrom(res) || started.cookie;
  return { res, cookie: signedIn, sid: sidOf(signedIn), before: started.cookie };
}

describe("login mode vendor", () => {
  test("start sends the browser to the service with PKCE, state, nonce and the configured extras", async () => {
    const { authorize } = await start();
    expect(authorize.origin + authorize.pathname).toBe(`${service.url}/oauth/authorize`);
    const p = authorize.searchParams;
    expect(p.get("client_id")).toBe("app-at-the-service");
    expect(p.get("redirect_uri")).toBe(VENDOR_REDIRECT);
    expect(p.get("scope")).toBe("openid profile email");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toBeTruthy();
    // VENDOR_AUTHORIZE_PARAMS adds its own parameters...
    expect(p.get("connection")).toBe("stx");
    // ...and can never replace the security ones.
    expect(p.getAll("state")).toHaveLength(1);
    expect(p.get("state")).not.toBe("attacker");
    expect(p.get("nonce")).not.toBe("attacker");
  });

  test("a valid login signs the person in on the service's subject, then sends them to link STX", async () => {
    const { res, sid } = await signIn({ sub: "svc|123", email: "jordan@example.com", name: "Jordan Park" });

    const user = userStore.find(sid, config.app.id)!;
    expect(user.externalId).toBe(`vendor:${service.url}|svc|123`);
    expect(user.name).toBe("Jordan Park");
    expect(user.email).toBe("jordan@example.com");
    // The service's tokens are not kept, and they are not an STX link.
    expect(linkStore.get(user.id)).toBeNull();

    // Not linked yet: straight on to the link step, with their email as a hint.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?login_hint=jordan%40example.com");
  });

  test("the link step that follows goes to STX with the app's STX client and the hint", async () => {
    const { res, cookie } = await signIn({ sub: "svc|link", email: "link@example.com" });
    const link = await app.request(res.headers.get("location")!, { headers: { cookie } });
    expect(link.status).toBe(302);
    const stx = new URL(link.headers.get("location")!);
    expect(stx.origin + stx.pathname).toBe("https://stx.example.com/oauth/authorize");
    expect(stx.searchParams.get("client_id")).toBe(config.app.clientId);
    expect(stx.searchParams.get("redirect_uri")).toBe("http://localhost:8787/callback");
    expect(stx.searchParams.get("login_hint")).toBe("link@example.com");
    expect(stx.searchParams.get("scope")).toContain("orders.write");
  });

  test("a returning user who already has an STX link is done after the service login", async () => {
    const first = await signIn({ sub: "svc|back", email: "back@example.com" });
    const uid = userStore.find(first.sid, config.app.id)!.id;
    linkStore.save({ userId: uid, appId: config.app.id, accessToken: "at", refreshToken: "rt", accessExpiresAt: null, scopes: [] });
    await app.request("/api/signout", { method: "POST", headers: { cookie: first.cookie } });

    const again = await signIn({ sub: "svc|back", email: "back@example.com" });
    expect(again.res.status).toBe(200);
    expect(await again.res.text()).toContain('"status":"signed_in"');
    expect(userStore.find(again.sid, config.app.id)!.id).toBe(uid);
    expect(linkStore.get(uid)?.accessToken).toBe("at");
  });

  test("signing in moves the browser to a new session id; the one it arrived with is signed in to nothing", async () => {
    const planted = "isv_sid=planted-by-someone-else";
    const { cookie, sid } = await signIn({ sub: "svc|fix", email: "fix@example.com" }, planted);
    expect(cookie).not.toBe(planted);
    expect(userStore.find(sid, config.app.id)?.externalId).toBe(`vendor:${service.url}|svc|fix`);
    expect(userStore.find("planted-by-someone-else", config.app.id)).toBeNull();
  });

  test("openid is always asked for, whatever VENDOR_SCOPES says", async () => {
    const { withOpenId } = await import("../../config");
    expect(withOpenId("profile email")).toBe("openid profile email");
    expect(withOpenId("email openid")).toBe("email openid");
  });

  test("linking needs the signed-in user", async () => {
    const res = await app.request("/login", { headers: { cookie: `isv_sid=s-${crypto.randomUUID()}` } });
    expect(await res.text()).toContain("not_signed_in");
  });

  test("a callback with a state this app never issued is refused", async () => {
    const { cookie } = await start();
    const before = service.requests.length;
    const page = await (await app.request("/auth/vendor/callback?code=x&state=nope", { headers: { cookie } })).text();
    expect(page).toContain("invalid_state");
    expect(service.requests.length).toBe(before);
  });

  test("a callback in another browser session is refused", async () => {
    const mine = await start();
    const other = await start();
    const back = await throughService(mine.authorize);
    const page = await (await app.request(back, { headers: { cookie: other.cookie } })).text();
    expect(page).toContain("session_mismatch");
  });

  test("an ID token with the wrong nonce is refused and nobody is signed in", async () => {
    const started = await start();
    service.member = { sub: "svc|bad", email: "bad@example.com" };
    service.forceNonce = "someone-elses-nonce";
    const res = await app.request(await throughService(started.authorize), { headers: { cookie: started.cookie } });
    expect(await res.text()).toContain("sign_in_failed");
    expect(userStore.find(sidOf(started.cookie), config.app.id)).toBeNull();
  });

  test("cancelling at the service comes back as its error", async () => {
    const started = await start();
    service.deny = true;
    const res = await app.request(await throughService(started.authorize), { headers: { cookie: started.cookie } });
    expect(await res.text()).toContain("access_denied");
  });

  test("signing out names the service's sign-out page, when it has one", async () => {
    const url = new URL((await vendorSignOutUrl())!);
    expect(url.origin + url.pathname).toBe(`${service.url}/logout`);
    expect(url.searchParams.get("client_id")).toBe("app-at-the-service");
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe(config.frontendUrl);
  });

  test("the secret can be sent as a form field instead of HTTP Basic", async () => {
    (config.vendor as { clientAuth: string }).clientAuth = "client_secret_post";
    resetVendorConfiguration();
    try {
      await signIn({ sub: "svc|post", email: "post@example.com" });
      const exchange = service.requests.filter((r) => r.path === "/oauth/token").at(-1)!;
      expect(exchange.authorization).toBe("");
      expect(exchange.form.get("client_secret")).toBe("service-secret");
    } finally {
      (config.vendor as { clientAuth: string }).clientAuth = "client_secret_basic";
      resetVendorConfiguration();
    }
  });

  test("this mode has no login of the app's own and no direct STX login", async () => {
    expect((await app.request("/api/login", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await app.request("/api/login/privy", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await app.request("/auth/stx/start")).status).toBe(404);
  });
});
