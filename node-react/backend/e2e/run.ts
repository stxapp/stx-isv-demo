// End-to-end run of every login mode.
//
//   bun run e2e/run.ts            every mode
//   bun run e2e/run.ts stx        one mode (own-mock, own-privy, stx, vendor)
//
// For each mode this starts the real backend (`bun run src/index.ts`, its own
// process, its own SQLite file) with that mode's settings, then walks every
// route the way a browser would: a cookie jar, redirects followed by hand.
//
// What is real: the backend, its routes, its database, the STX TypeScript SDK
// and openid-client, and every request they send (PKCE, state, nonce, the code
// exchange, ID token signature checks, bearer calls, refresh, revoke).
//
// What is mocked: STX itself and the login service are local servers
// (test-support/mockStx.ts), and the person is mocked: the mock answers
// /oauth/authorize at once, as if they had logged in and allowed the app. Live
// WebSocket feeds are not mocked, so the two streaming routes are only checked
// to open. Privy cannot be reached without real keys, so `own-privy` checks the
// mode's wiring and that a forged token is refused; a real Privy login is
// covered by the unit tests with the verifier stubbed.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockStx, type MockStx } from "../test-support/mockStx";

type Mode = "own-mock" | "own-privy" | "stx" | "vendor";
const ALL: Mode[] = ["own-mock", "own-privy", "stx", "vendor"];

const STX_CLIENT = { clientId: "stxapp_client_e2e", clientSecret: "e2e-stx-secret" };
const VENDOR_CLIENT = { clientId: "e2e-app-at-service", clientSecret: "e2e-service-secret" };
const SCOPES = "profile.read balance.read portfolio.read orders.read orders.write";

// ---- a minimal browser: cookies + manual redirects --------------------------

class Browser {
  private cookies = new Map<string, string>();
  constructor(readonly origin: string) {}

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const target = new URL(url, this.origin);
    const headers = new Headers(init.headers);
    // Cookies go to the app only, as in a browser.
    if (target.origin === this.origin && this.cookies.size > 0) {
      headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const res = await fetch(target, { ...init, headers, redirect: "manual" });
    if (target.origin === this.origin) {
      for (const line of res.headers.getSetCookie()) {
        const [pair] = line.split(";");
        const eq = pair!.indexOf("=");
        const name = pair!.slice(0, eq);
        const value = pair!.slice(eq + 1);
        if (value === "") this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
    }
    return res;
  }

  // Follow redirects across the app, STX and the login service. Returns the
  // final response and every URL visited.
  async follow(url: string): Promise<{ res: Response; trail: string[] }> {
    const trail: string[] = [];
    let next = new URL(url, this.origin).href;
    for (let i = 0; i < 10; i++) {
      trail.push(next);
      const res = await this.request(next);
      const location = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !location) return { res, trail };
      next = new URL(location, next).href;
    }
    throw new Error(`too many redirects: ${trail.join(" -> ")}`);
  }

  async json<T = Record<string, unknown>>(url: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const res = await this.request(url, init);
    const text = await res.text();
    let body: unknown = {};
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    return { status: res.status, body: body as T };
  }
}

// ---- checks ------------------------------------------------------------------

let failures = 0;
let checks = 0;
function check(mode: Mode, what: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) console.log(`::error title=${mode}::${what} ${detail}`);
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port!;
  s.stop(true);
  return port;
}

// ---- one mode ----------------------------------------------------------------

async function runMode(mode: Mode): Promise<void> {
  console.log(`\n== ${mode} ==`);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(join(tmpdir(), "isv-e2e-"));

  const stx = await startMockStx({
    clients: [{ ...STX_CLIENT, redirectUris: [`${origin}/callback`, `${origin}/auth/stx/callback`] }],
    member: { sub: "stx-member-1", email: "member@example.com", name: "Morgan Lee" },
  });
  let service: MockStx | null = null;

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    PORT: String(port),
    DB_PATH: join(dir, "isv.sqlite"),
    STX_BASE_URL: stx.url,
    PUBLIC_URL: origin,
    CLIENT_ID: STX_CLIENT.clientId,
    CLIENT_SECRET: STX_CLIENT.clientSecret,
    OAUTH_SCOPES: SCOPES,
  };
  // `stx` mode is started with its own redirect URI only, as its setup says.
  if (mode === "stx") {
    delete env.PUBLIC_URL;
    Object.assign(env, { STX_LOGIN_REDIRECT_URI: `${origin}/auth/stx/callback`, FRONTEND_URL: origin });
  }
  if (mode === "own-mock") Object.assign(env, { LOGIN_MODE: "own", OWN_LOGIN: "mock" });
  if (mode === "own-privy") {
    Object.assign(env, { LOGIN_MODE: "own", OWN_LOGIN: "privy", PRIVY_APP_ID: "e2e-not-a-real-app", PRIVY_APP_SECRET: "e2e-not-a-real-secret" });
  }
  if (mode === "stx") Object.assign(env, { LOGIN_MODE: "stx", APP_ID: "playbook", APP_NAME: "Playbook" });
  if (mode === "vendor") {
    service = await startMockStx({
      clients: [{ ...VENDOR_CLIENT, redirectUris: [`${origin}/auth/vendor/callback`] }],
      member: { sub: "service|user-1", email: "member@example.com", name: "Morgan Lee" },
    });
    Object.assign(env, {
      LOGIN_MODE: "vendor",
      APP_ID: "clubhouse",
      APP_NAME: "Clubhouse",
      VENDOR_NAME: "Example Login",
      VENDOR_ISSUER: service.url,
      VENDOR_CLIENT_ID: VENDOR_CLIENT.clientId,
      VENDOR_CLIENT_SECRET: VENDOR_CLIENT.clientSecret,
      VENDOR_AUTHORIZE_PARAMS: "connection=stx",
      VENDOR_ALLOW_INSECURE: "true",
    });
  }

  const before = failures;
  const backend = Bun.spawn(["bun", "run", "src/index.ts"], { env, stdout: "pipe", stderr: "pipe" });
  const browser = new Browser(origin);
  try {
    await waitForHealth(origin, backend);
    if (mode === "own-privy") await ownPrivy(mode, browser);
    else await fullJourney(mode, browser, stx, service);
  } catch (err) {
    check(mode, "the run completed", false, String(err));
  } finally {
    backend.kill();
    await backend.exited;
    if (failures > before) {
      console.log("--- backend output ---");
      console.log(await new Response(backend.stdout).text());
      console.log(await new Response(backend.stderr).text());
    }
    stx.stop();
    service?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitForHealth(origin: string, backend: { exitCode: number | null }): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (backend.exitCode !== null) throw new Error(`the backend exited with ${backend.exitCode} before it was healthy`);
    try {
      if ((await fetch(`${origin}/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(100);
  }
  throw new Error("the backend did not become healthy");
}

// Which login routes each mode must answer; every other one must be a 404.
const LOGIN_ROUTES: Record<string, Mode[]> = {
  "POST /api/login": ["own-mock"],
  "POST /api/login/privy": ["own-privy"],
  "GET /login": ["own-mock", "own-privy", "vendor"],
  "GET /callback": ["own-mock", "own-privy", "vendor"],
  "GET /auth/stx/start": ["stx"],
  "GET /auth/stx/callback": ["stx"],
  "GET /auth/vendor/start": ["vendor"],
  "GET /auth/vendor/callback": ["vendor"],
};

async function modeWiring(mode: Mode, browser: Browser): Promise<void> {
  const expected = mode.startsWith("own") ? "own" : mode;
  const health = await browser.json<{ ok: boolean; loginMode: string }>("/health");
  check(mode, "GET /health reports the mode", health.body.ok && health.body.loginMode === expected, JSON.stringify(health.body));

  const app = await browser.json<{ app: { id: string; name: string }; login: { mode: string; own: string | null; privyAppId: string | null; vendorName: string | null } }>("/api/app");
  check(mode, "GET /api/app names the mode for the browser", app.body.login?.mode === expected, JSON.stringify(app.body.login));
  if (mode === "own-mock") check(mode, "the app's own login is the mock", app.body.login.own === "mock");
  if (mode === "own-privy") check(mode, "the app's own login is Privy, with its public App ID", app.body.login.own === "privy" && app.body.login.privyAppId === "e2e-not-a-real-app");
  if (mode === "vendor") check(mode, "the login service's name is sent for the button", app.body.login.vendorName === "Example Login");
  check(mode, "no secret is in /api/app", !JSON.stringify(app.body).includes("secret"));

  // A fresh visitor (no cookie) for the route table, so nothing is signed in by it.
  const visitor = new Browser(browser.origin);
  for (const [route, modes] of Object.entries(LOGIN_ROUTES)) {
    const [method, path] = route.split(" ") as [string, string];
    const res = await visitor.request(path, { method, body: method === "POST" ? "{}" : undefined });
    const off = res.status === 404 && (await res.text()).includes("not_in_this_login_mode");
    const on = modes.includes(mode);
    check(mode, `${route} is ${on ? "on" : "off"}`, on !== off, `status ${res.status}`);
  }

  const me = await browser.json<{ user: unknown }>("/api/me");
  check(mode, "GET /api/me before sign-in: nobody", me.status === 200 && me.body.user === null);
  const wallet = await browser.json("/api/wallet");
  check(mode, "GET /api/wallet before sign-in is refused", wallet.status === 401);
}

async function ownPrivy(mode: Mode, browser: Browser): Promise<void> {
  await modeWiring(mode, browser);
  const forged = await browser.json("/api/login/privy", { method: "POST", body: JSON.stringify({ accessToken: "forged" }) });
  check(mode, "a forged Privy token is refused", forged.status === 401, `status ${forged.status}`);
  const none = await browser.json("/api/login/privy", { method: "POST", body: "{}" });
  check(mode, "a missing Privy token is a 400", none.status === 400);
  const link = await browser.request("/login");
  check(mode, "linking before signing in is refused", (await link.text()).includes("not_signed_in"));
}

// Sign in the way the mode does it; returns the page the trip ended on.
async function signIn(mode: Mode, browser: Browser): Promise<{ page: string; trail: string[] }> {
  if (mode === "own-mock") {
    const login = await browser.json<{ user: { name: string } }>("/api/login", { method: "POST", body: JSON.stringify({ name: "Morgan Lee" }) });
    check(mode, "POST /api/login signs in the mock user", login.status === 200 && login.body.user.name === "Morgan Lee");
    const { res, trail } = await browser.follow("/login");
    return { page: await res.text(), trail };
  }
  const { res, trail } = await browser.follow(mode === "stx" ? "/auth/stx/start" : "/auth/vendor/start");
  return { page: await res.text(), trail };
}

async function fullJourney(mode: Mode, browser: Browser, stx: MockStx, service: MockStx | null): Promise<void> {
  await modeWiring(mode, browser);

  // ---- sign in and link ----
  const { page, trail } = await signIn(mode, browser);
  const paths = trail.map((u) => new URL(u).pathname);
  check(mode, "the sign-in ends linked to STX", page.includes('"status":"linked"'), paths.join(" -> "));
  const expectedTrail: Record<string, string[]> = {
    "own-mock": ["/login", "/oauth/authorize", "/callback"],
    stx: ["/auth/stx/start", "/oauth/authorize", "/auth/stx/callback"],
    vendor: ["/auth/vendor/start", "/oauth/authorize", "/auth/vendor/callback", "/login", "/oauth/authorize", "/callback"],
  };
  check(mode, `the browser went ${expectedTrail[mode]!.join(" -> ")}`, JSON.stringify(paths) === JSON.stringify(expectedTrail[mode]), paths.join(" -> "));

  const authorize = stx.requests.filter((r) => r.path === "/oauth/authorize").at(-1)!;
  const scope = authorize.query.get("scope") ?? "";
  check(mode, "STX was asked with PKCE (S256) and a state", authorize.query.get("code_challenge_method") === "S256" && Boolean(authorize.query.get("state")));
  check(mode, `openid is ${mode === "stx" ? "requested" : "not requested"} at STX`, scope.split(" ").includes("openid") === (mode === "stx"), scope);
  if (mode === "vendor") {
    const atService = service!.requests.find((r) => r.path === "/oauth/authorize")!;
    check(mode, "the login service was asked with openid, a nonce and the configured extra", atService.query.get("scope") === "openid profile email" && Boolean(atService.query.get("nonce")) && atService.query.get("connection") === "stx");
    check(mode, "the link step carried the email from the login service as a hint", authorize.query.get("login_hint") === "member@example.com");
  }
  const exchange = stx.requests.filter((r) => r.path === "/oauth/token" && r.form.get("grant_type") === "authorization_code").at(-1);
  check(mode, "the code was exchanged with the PKCE verifier", Boolean(exchange?.form.get("code_verifier")));
  check(mode, "no token reached the browser", !page.includes("mock_at_") && !page.includes("mock_rt_"));

  const me = await browser.json<{ user: { id: string; name: string; email: string | null }; link: { connected: boolean; scopes: string[] } }>("/api/me?verify=1");
  check(mode, "GET /api/me: signed in and linked (verified with a live STX call)", me.body.user?.name === "Morgan Lee" && me.body.link.connected, JSON.stringify(me.body));
  if (mode !== "own-mock") check(mode, "the user's email came from the login", me.body.user.email === "member@example.com");
  const userId = me.body.user.id;

  // ---- everything after sign-in is the same in every mode ----
  const wallet = await browser.json<{ stx: { linked: boolean; cashCents: number | null } }>("/api/wallet");
  check(mode, "GET /api/wallet shows the app wallet and the STX balance", wallet.status === 200 && wallet.body.stx.linked && wallet.body.stx.cashCents === 9130, JSON.stringify(wallet.body.stx));
  const deposit = await browser.json<{ user: { walletCents: number } }>("/api/wallet/deposit", { method: "POST", body: JSON.stringify({ cents: 500 }) });
  check(mode, "POST /api/wallet/deposit tops up the app's own wallet", deposit.status === 200 && deposit.body.user.walletCents === 25_500);
  const balance = await browser.json<{ balance: { available_balance: string } }>("/api/balance");
  check(mode, "GET /api/balance", balance.status === 200 && balance.body.balance.available_balance === "91.3000");

  const order = { market_id: "42b861f8-8340-4046-ae06-83a0cec93456", action: "buy", order_type: "limit", price: 1, quantity: "1" };
  const placed = await browser.json<{ order: { id: string; status: string } }>("/api/orders", { method: "POST", body: JSON.stringify(order) });
  check(mode, "POST /api/orders places an order", placed.status === 200 && placed.body.order?.status === "accepted", JSON.stringify(placed.body));
  const rejected = await browser.json("/api/orders", { method: "POST", body: JSON.stringify({ ...order, quantity: "" }) });
  check(mode, "an invalid order is refused, not a 500", rejected.status === 400 || rejected.status === 422, `status ${rejected.status}`);
  const batch = await browser.json<{ results: unknown[] }>("/api/orders/batch", { method: "POST", body: JSON.stringify({ orders: [order, order] }) });
  check(mode, "POST /api/orders/batch places two orders", batch.status === 200 && batch.body.results?.length === 2, JSON.stringify(batch.body));
  const orders = await browser.json<{ orders: { id: string }[] }>("/api/orders");
  check(mode, "GET /api/orders lists them", orders.status === 200 && orders.body.orders.length === 3);
  const cancelled = await browser.json<{ status: string }>(`/api/orders/${placed.body.order?.id}`, { method: "DELETE" });
  check(mode, "DELETE /api/orders/:id cancels one", cancelled.status === 200 && cancelled.body.status === "cancelled", JSON.stringify(cancelled.body));
  const trades = await browser.json("/api/trades");
  check(mode, "GET /api/trades", trades.status === 200);
  const settlements = await browser.json("/api/settlements");
  check(mode, "GET /api/settlements", settlements.status === 200);

  const markets = await browser.json<{ markets?: unknown[] }>("/api/markets");
  check(mode, "GET /api/markets reads the catalog on the app's own token", markets.status === 200, JSON.stringify(markets.body).slice(0, 200));
  const appToken = stx.requests.find((r) => r.path === "/oauth/token" && r.form.get("grant_type") === "client_credentials");
  check(mode, "the app token asked for market_data only", appToken?.form.get("scope") === "market_data");
  const marketTrades = await browser.json(`/api/markets/${order.market_id}/trades`);
  check(mode, "GET /api/markets/:id/trades", marketTrades.status === 200, JSON.stringify(marketTrades.body).slice(0, 200));

  const activity = await browser.json<{ activity: { id: number; path: string }[] }>("/api/activity");
  check(mode, "GET /api/activity logs the STX calls made for this user", activity.status === 200 && activity.body.activity.some((a) => a.path === "/api/v1/orders"));
  const detail = await browser.json(`/api/activity/${activity.body.activity[0]?.id}/detail`);
  check(mode, "GET /api/activity/:id/detail", detail.status === 200);
  check(mode, "the activity log carries no token", !JSON.stringify(activity.body).includes("mock_at_") && !JSON.stringify(detail.body).includes("mock_at_"));

  for (const path of ["/api/stream", `/api/market-stream?topic=ticker&market_ids=${order.market_id}`]) {
    const res = await browser.request(path);
    check(mode, `GET ${path.split("?")[0]} opens an event stream`, res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/event-stream"), `status ${res.status}`);
    await res.body?.cancel();
  }

  // ---- unlink, link again ----
  const unlink = await browser.json("/api/unlink", { method: "POST" });
  const revoke = stx.requests.filter((r) => r.path === "/oauth/revoke").at(-1);
  check(mode, "POST /api/unlink revokes the refresh token at STX", unlink.status === 200 && revoke?.form.get("token_type_hint") === "refresh_token");
  const unlinked = await browser.json<{ user: unknown; link: { connected: boolean } }>("/api/me");
  check(mode, "after unlink: still signed in, no STX link", unlinked.body.user !== null && !unlinked.body.link.connected);
  const noLink = await browser.json("/api/balance");
  check(mode, "an STX call without a link is a 401, not a 500", noLink.status === 401);

  const relink = await browser.follow(mode === "stx" ? "/auth/stx/start" : "/login");
  check(mode, "linking again works", (await relink.res.text()).includes('"status":"linked"'));
  const relinked = await browser.json<{ user: { id: string }; link: { connected: boolean } }>("/api/me");
  check(mode, "after linking again: the same user, linked", relinked.body.user?.id === userId && relinked.body.link.connected);

  // ---- cancel at STX ----
  stx.deny = true;
  const denied = await browser.follow(mode === "stx" ? "/auth/stx/start" : "/login");
  check(mode, "cancelling at STX comes back as access_denied", (await denied.res.text()).includes("access_denied"));

  // ---- the member's STX account goes back to being verified ----
  stx.pending = true;
  const pendingCall = await browser.json<{ error: string; message: string }>("/api/balance");
  check(mode, "while STX is verifying the member, a call answers account_pending with a sentence for them", pendingCall.status === 409 && pendingCall.body.error === "account_pending" && pendingCall.body.message.length > 20, JSON.stringify(pendingCall.body));
  const pendingMe = await browser.json<{ user: { id: string }; link: { connected: boolean } }>("/api/me?verify=1");
  check(mode, "their link is kept meanwhile", pendingMe.body.user?.id === userId && pendingMe.body.link.connected);
  const pendingStart = await browser.follow(mode === "stx" ? "/auth/stx/start" : "/login");
  check(mode, "logging in or linking meanwhile comes back as account_pending", (await pendingStart.res.text()).includes('"error":"account_pending"'));
  const stillThere = await browser.json<{ user: { id: string } | null; link: { connected: boolean } }>("/api/me");
  check(mode, "and leaves them signed in and linked", stillThere.body.user?.id === userId && stillThere.body.link.connected);
  stx.pending = false;
  const afterPending = await browser.json("/api/balance");
  check(mode, "once STX has verified them, calls work again with no new link", afterPending.status === 200, `status ${afterPending.status}`);

  // ---- sign out, sign in again ----
  const out = await browser.json<{ ok: boolean; signOutUrl: string | null }>("/api/signout", { method: "POST" });
  check(mode, "POST /api/signout", out.status === 200 && out.body.ok);
  if (mode === "vendor") check(mode, "sign-out names the login service's sign-out page", (out.body.signOutUrl ?? "").startsWith(`${service!.url}/logout?`));
  else check(mode, "sign-out has nowhere else to send the browser", out.body.signOutUrl === null);
  const gone = await browser.json<{ user: unknown }>("/api/me");
  check(mode, "after sign-out: nobody", gone.body.user === null);

  const again = await signIn(mode, browser);
  const back = await browser.json<{ user: { id: string }; link: { connected: boolean } }>("/api/me");
  if (mode === "own-mock") {
    // The mock login has no account behind it: sign-out removed the user.
    check(mode, "signing in again makes a new mock user", back.body.user.id !== userId && back.body.link.connected);
  } else {
    check(mode, "signing in again lands on the same account, still linked", back.body.user?.id === userId && back.body.link.connected, JSON.stringify(back.body));
    if (mode === "vendor") {
      check(mode, "a returning linked user skips the link step", again.page.includes('"status":"signed_in"') && !again.trail.some((u) => new URL(u).pathname === "/login"));
    }
  }

  // ---- the built frontend, when present (CI builds it into ./public) ----
  const home = await browser.request("/");
  if (home.status === 200) {
    const html = await home.text();
    const name = mode === "stx" ? "Playbook" : mode === "vendor" ? "Clubhouse" : "Sideline";
    check(mode, `GET / serves the page as ${name}`, html.includes(`<title>${name}: STX sample app</title>`) && !html.includes("__PUBLIC_URL__"));
    if (mode === "stx") check(mode, "Playbook's own icons are used", html.includes("/assets/brand/playbook-icon.svg") && html.includes("/assets/brand/playbook/og-image.png"));
  } else if (process.env.E2E_EXPECT_FRONTEND === "1") {
    check(mode, "GET / serves the built frontend", false, `status ${home.status}`);
  } else {
    console.log("  skip GET / (no built frontend in ./public)");
  }
}

// ---- main --------------------------------------------------------------------

const wanted = process.argv.slice(2) as Mode[];
for (const m of wanted) if (!ALL.includes(m)) throw new Error(`unknown mode ${m}; choose from ${ALL.join(", ")}`);
for (const mode of wanted.length > 0 ? wanted : ALL) await runMode(mode);

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
