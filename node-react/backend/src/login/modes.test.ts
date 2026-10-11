// The login-mode switch: each mode mounts its own routes and nothing else, and
// the browser is told which sign-in to draw.

import { describe, expect, test } from "bun:test";

process.env.STX_BASE_URL = "https://stx.example.com";
process.env.CLIENT_ID = "sideline-test-client-id";
process.env.CLIENT_SECRET = "sideline-test-client-secret";
process.env.REDIRECT_URI = "http://localhost:8787/callback";
process.env.OAUTH_SCOPES = "profile.read balance.read portfolio.read orders.read orders.write";
process.env.DB_PATH = ":memory:";

const { config } = await import("../config");
const { loginRoutes, publicLogin } = await import("./index");

// Whether a mode's routes answer a path at all (anything but a router 404).
async function mounted(routes: ReturnType<typeof loginRoutes>, method: string, path: string): Promise<boolean> {
  const res = await routes.request(path, { method, body: method === "POST" ? "{}" : undefined });
  return !(res.status === 404 && (await res.text()) === "404 Not Found");
}

const ROUTES: [string, string][] = [
  ["POST", "/api/login"],
  ["POST", "/api/login/privy"],
  ["GET", "/login"],
  ["GET", "/callback"],
  ["GET", "/auth/stx/start"],
  ["GET", "/auth/stx/callback"],
  ["GET", "/auth/vendor/start"],
  ["GET", "/auth/vendor/callback"],
];

async function mountedRoutes(routes: ReturnType<typeof loginRoutes>): Promise<string[]> {
  const out: string[] = [];
  for (const [method, path] of ROUTES) if (await mounted(routes, method, path)) out.push(`${method} ${path}`);
  return out;
}

describe("login-mode switch", () => {
  test("own + mock: the mock login and the link step", async () => {
    expect(await mountedRoutes(loginRoutes("own", "mock"))).toEqual(["POST /api/login", "GET /login", "GET /callback"]);
  });

  test("own + privy: the Privy login and the link step", async () => {
    expect(await mountedRoutes(loginRoutes("own", "privy"))).toEqual([
      "POST /api/login/privy",
      "GET /login",
      "GET /callback",
    ]);
  });

  test("stx: logging in with an STX account, and nothing else", async () => {
    expect(await mountedRoutes(loginRoutes("stx", "mock"))).toEqual(["GET /auth/stx/start", "GET /auth/stx/callback"]);
  });

  test("vendor: the login service and the link step", async () => {
    expect(await mountedRoutes(loginRoutes("vendor", "mock"))).toEqual([
      "GET /login",
      "GET /callback",
      "GET /auth/vendor/start",
      "GET /auth/vendor/callback",
    ]);
  });

  test("the default is own, with the mock login when no Privy keys are set", () => {
    expect(config.login).toEqual({ mode: "own", own: "mock" });
  });

  test("the browser is told the mode and only what it needs for it", () => {
    const login = config.login as { mode: string; own: string };
    const original = { ...login };
    try {
      expect(publicLogin()).toEqual({ mode: "own", own: "mock", privyAppId: null, vendorName: null });
      login.mode = "stx";
      expect(publicLogin()).toEqual({ mode: "stx", own: null, privyAppId: null, vendorName: null });
      login.mode = "vendor";
      expect(publicLogin()).toMatchObject({ mode: "vendor", own: null, privyAppId: null });
      expect(publicLogin().vendorName).toBeTruthy();
    } finally {
      Object.assign(login, original);
    }
  });
});
