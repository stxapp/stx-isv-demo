// The app's session cookie: the only thing the browser holds. It must be
// httpOnly (no script can read it), SameSite=Lax, Secure when configured, and
// scoped to the whole app.

import { describe, expect, test } from "bun:test";

process.env.STX_BASE_URL = "https://stx.example.com";
process.env.CLIENT_ID = "sideline-test-client-id";
process.env.CLIENT_SECRET = "sideline-test-client-secret";
process.env.REDIRECT_URI = "http://localhost:8787/callback";
process.env.DB_PATH = ":memory:";

const { Hono } = await import("hono");
const { config } = await import("./config");
const { clearSession, getOrCreateSession, startSession } = await import("./session");

// `config` is one shared singleton across test files, so pin the flag here.
(config as { cookieSecure: boolean }).cookieSecure = true;

function app() {
  const a = new Hono();
  a.get("/new", (c) => c.text(getOrCreateSession(c)));
  a.get("/start", (c) => c.text(startSession(c)));
  a.get("/clear", (c) => {
    clearSession(c);
    return c.text("ok");
  });
  return a;
}

describe("session cookie", () => {
  test("a new session cookie is httpOnly, SameSite=Lax, Secure and app-wide", async () => {
    const res = await app().request("/new");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^isv_sid=[A-Za-z0-9_-]{32};/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=604800");
  });

  test("an existing session is reused, and no new cookie is set", async () => {
    const res = await app().request("/new", { headers: { cookie: "isv_sid=abc" } });
    expect(await res.text()).toBe("abc");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("starting a session replaces whatever id the browser sent", async () => {
    const res = await app().request("/start", { headers: { cookie: "isv_sid=abc" } });
    const id = await res.text();
    expect(id).not.toBe("abc");
    expect(res.headers.get("set-cookie")).toStartWith(`isv_sid=${id};`);
  });

  test("clearing the session expires the cookie with the same flags", async () => {
    const cookie = (await app().request("/clear")).headers.get("set-cookie") ?? "";
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
  });
});
