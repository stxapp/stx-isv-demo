// A real run against a real STX exchange, in a real browser. Not part of CI:
// it needs your STX client, a member's email and password, and Playwright.
//
// Start the app first, in the mode you want to try, with the built frontend
// served by the backend so everything is on one origin:
//
//   (cd frontend && VITE_BACKEND_URL="" bun run build && cp -R dist ../backend/public)
//   (cd backend && PUBLIC_URL=http://localhost:8787 LOGIN_MODE=stx bun run src/index.ts)
//
// Then, from backend/:
//
//   APP_URL=http://localhost:8787 MEMBER_EMAIL=... MEMBER_PASSWORD=... \
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs \
//   node e2e/live.mjs
//
// It reads the mode from the app, signs in the way that mode does, logs in and
// allows the app on STX's own pages, then reads the wallet and balance, places
// one 1-cent limit order and cancels it, reads orders, trades, settlements,
// markets and the API calls log, unlinks and signs out. SCREENSHOT_DIR saves a
// picture of the app at each stage. Modes: `own` with the mock login, and `stx`.
// Use a sandbox member: the order is real on that exchange until it is cancelled.

import { mkdirSync } from "node:fs";

const env = process.env;
for (const name of ["APP_URL", "MEMBER_EMAIL", "MEMBER_PASSWORD", "PLAYWRIGHT_MODULE"]) {
  if (!env[name]) throw new Error(`Set ${name}.`);
}
const { chromium } = await import(env.PLAYWRIGHT_MODULE);
const APP = env.APP_URL.replace(/\/+$/, "");
const shots = env.SCREENSHOT_DIR;
if (shots) mkdirSync(shots, { recursive: true });

let failures = 0;
function check(what, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `  (${String(detail).slice(0, 240)})` : ""}`);
}

const browser = await chromium.launch({
  ...(env.CHROME_PATH ? { executablePath: env.CHROME_PATH } : { channel: "chrome" }),
  headless: env.HEADED !== "1",
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const api = ctx.request; // shares the browser's cookies

async function shot(name) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}
async function json(method, path, data) {
  const res = await api.fetch(APP + path, { method, data, failOnStatusCode: false });
  let body = {};
  try {
    body = await res.json();
  } catch {
    body = { raw: (await res.text()).slice(0, 200) };
  }
  return { status: res.status(), body };
}

// Walk STX's own pages: log in if asked, allow the app if asked, until the
// browser is back on the app. Returns the hosts visited on the way.
async function throughStx(stxHost) {
  const hosts = new Set();
  let loggedIn = false;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const url = new URL(page.url());
    hosts.add(url.host);
    if (url.origin === APP && !url.pathname.startsWith("/auth/") && url.pathname !== "/login" && url.pathname !== "/callback") {
      return [...hosts];
    }
    if (url.host === stxHost) {
      if (!loggedIn && (await page.locator("#v3-login-email").isVisible().catch(() => false))) {
        await shot("stx-login-page");
        await page.fill("#v3-login-email", env.MEMBER_EMAIL);
        await page.fill("#v3-login-password", env.MEMBER_PASSWORD);
        const fit = page.locator("#v3-login-fit-to-participate");
        if (await fit.isVisible().catch(() => false)) await fit.check();
        await page.getByRole("button", { name: /^log in$/i }).click();
        loggedIn = true;
      } else {
        const allow = page.getByRole("button", { name: /^(allow|approve|authori[sz]e|continue|connect)\b/i }).first();
        if (await allow.isVisible().catch(() => false)) {
          await shot("stx-consent-page");
          // One click per page: a second click on the same page would send the
          // browser back to the app twice with the same single-use state.
          const before = page.url();
          await allow.click().catch(() => {});
          await page.waitForURL((u) => u.href !== before, { timeout: 15_000 }).catch(() => {});
        }
      }
    }
    await page.waitForTimeout(600);
  }
  throw new Error(`stuck at ${page.url().split("?")[0]}`);
}

try {
  const health = await json("GET", "/health");
  const mode = health.body.loginMode;
  const stxHost = new URL(health.body.stxPublicUrl ?? health.body.stxBaseUrl).host;
  console.log(`app ${APP} | login mode ${mode} | STX ${stxHost}`);
  const app = await json("GET", "/api/app");
  if (mode === "own" && app.body.login.own !== "mock") throw new Error("In own mode this script drives the mock login only.");
  if (mode === "vendor") throw new Error("vendor mode needs a login service; this script covers own (mock) and stx.");

  await page.goto(APP + "/");
  await page.locator(".signin").waitFor({ timeout: 20_000 });
  await shot("1-signed-out");
  check("the app shows this mode's sign-in", await page.locator(mode === "stx" ? "#signin-stx" : ".signin-form").isVisible());

  // ---- sign in and link, as a full-page trip ----
  if (mode === "own") {
    const login = await json("POST", "/api/login", { name: "Live run" });
    check("mock login", login.status === 200);
    await page.goto(APP + "/login");
  } else {
    await page.goto(APP + "/auth/stx/start");
  }
  const hosts = await throughStx(stxHost);
  check("the member logged in and allowed the app on STX's own pages", hosts.includes(stxHost), hosts.join(" -> "));
  await page.locator(".wallets").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(2500);
  await shot("2-signed-in-linked");

  const me = await json("GET", "/api/me?verify=1");
  check("signed in and linked (verified with a live STX call)", me.body.user && me.body.link?.connected, JSON.stringify(me.body.link));
  check("granted scopes include orders.write", (me.body.link?.scopes ?? []).includes("orders.write"), (me.body.link?.scopes ?? []).join(" "));
  if (mode === "stx") {
    check("the user's email came from STX's ID token", me.body.user?.email?.toLowerCase() === env.MEMBER_EMAIL.toLowerCase());
    check("granted scopes include openid", (me.body.link?.scopes ?? []).includes("openid"));
  }

  // ---- everything after sign-in ----
  const wallet = await json("GET", "/api/wallet");
  check("wallet: app wallet and live STX balance", wallet.status === 200 && wallet.body.stx?.linked && wallet.body.stx?.cashCents !== null, `stx cash cents: ${typeof wallet.body.stx?.cashCents}`);
  const balance = await json("GET", "/api/balance");
  check("GET /api/balance", balance.status === 200 && balance.body.balance !== undefined, `status ${balance.status}`);

  const markets = await json("GET", "/api/markets");
  const list = markets.body.markets ?? [];
  check("GET /api/markets (the app's own token)", markets.status === 200 && list.length > 0, `status ${markets.status}, ${list.length} markets`);
  // An open market on a game that has not started, so the order just rests.
  const market = list.find((m) => m.status === "open" && m.eventStatus !== "in_progress") ?? list.find((m) => m.status === "open");
  const marketId = market?.marketId;

  if (marketId) {
    const placed = await json("POST", "/api/orders", { market_id: marketId, action: "buy", order_type: "limit", price: 1, quantity: "1" });
    const orderId = placed.body.order?.id;
    check("POST /api/orders: a 1-cent limit buy is accepted", placed.status === 200 && Boolean(orderId), `status ${placed.status} ${placed.body.error ?? placed.body.order?.status ?? ""}`);
    const orders = await json("GET", "/api/orders");
    check("GET /api/orders lists it", orders.status === 200 && (orders.body.orders ?? []).some((o) => o.id === orderId), `status ${orders.status}`);
    if (orderId) {
      await page.waitForTimeout(1500);
      await shot("3-open-order");
      const cancelled = await json("DELETE", `/api/orders/${orderId}`);
      check("DELETE /api/orders/:id cancels it", cancelled.status === 200, `status ${cancelled.status} ${cancelled.body.error ?? cancelled.body.status ?? ""}`);
    }
    const trades = await json("GET", `/api/markets/${marketId}/trades`);
    check("GET /api/markets/:id/trades", trades.status === 200, `status ${trades.status}`);
  } else {
    check("a market to place an order on", false, "no markets");
  }
  check("GET /api/trades", (await json("GET", "/api/trades")).status === 200);
  check("GET /api/settlements", (await json("GET", "/api/settlements")).status === 200);
  const activity = await json("GET", "/api/activity");
  const rows = activity.body.activity ?? [];
  check("the API calls log recorded the STX calls", rows.some((r) => String(r.path).includes("/orders")), `${rows.length} rows`);
  check("no token in the API calls log", !/"(access|refresh|id)_token":"[A-Za-z0-9._-]{20,}/.test(JSON.stringify(activity.body)));

  // An event stream never ends, so read the status and type from the page and
  // stop there.
  const stream = await page.evaluate(async (url) => {
    const stop = new AbortController();
    try {
      const res = await fetch(url, { signal: stop.signal, credentials: "include" });
      return { status: res.status, type: res.headers.get("content-type") ?? "" };
    } catch (err) {
      return { status: 0, type: String(err) };
    } finally {
      stop.abort();
    }
  }, APP + "/api/stream");
  check("GET /api/stream opened as an event stream", stream.status === 200 && stream.type.includes("text/event-stream"), `status ${stream.status} ${stream.type}`);

  // ---- sign out and back in: the account and link are kept ----
  if (mode === "stx") {
    const userId = me.body.user.id;
    await json("POST", "/api/signout");
    check("after sign-out: nobody", (await json("GET", "/api/me")).body.user === null);
    await page.goto(APP + "/auth/stx/start");
    await throughStx(stxHost);
    const back = await json("GET", "/api/me");
    check("logging in again lands on the same account, linked", back.body.user?.id === userId && back.body.link?.connected);
  }

  // ---- unlink (revokes at STX), then sign out ----
  const unlink = await json("POST", "/api/unlink");
  check("POST /api/unlink", unlink.status === 200);
  const after = await json("GET", "/api/me?verify=1");
  check("after unlink: signed in, not linked", after.body.user && !after.body.link?.connected);
  const dead = await json("GET", "/api/balance");
  check("STX calls are refused after unlink", dead.status === 401, `status ${dead.status}`);
  await page.goto(APP + "/");
  await page.waitForTimeout(2000);
  await shot("4-unlinked");
  const out = await json("POST", "/api/signout");
  check("POST /api/signout", out.status === 200);
} catch (err) {
  check("the run completed", false, err?.message ?? err);
  await shot("failure").catch(() => {});
} finally {
  await browser.close();
}
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
