// Local session cookie helpers.
//
// The "session" here is purely the ISV app's own login state: an opaque id in
// an httpOnly cookie that keys the server-side token store. It is unrelated to
// STX's session; STX only ever sees bearer tokens.

import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { config } from "./config";

const COOKIE_NAME = "isv_sid";

function newSessionId(): string {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString("base64url");
}

// Returns the existing session id from the cookie, or mints one and sets it.
export function getOrCreateSession(c: Context): string {
  const existing = getCookie(c, COOKIE_NAME);
  if (existing) return existing;

  const sid = newSessionId();
  setCookie(c, COOKIE_NAME, sid, {
    httpOnly: true,
    sameSite: "Lax",
    secure: config.cookieSecure,
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // one week
  });
  return sid;
}

export function getSession(c: Context): string | undefined {
  return getCookie(c, COOKIE_NAME);
}

export function clearSession(c: Context): void {
  setCookie(c, COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "Lax",
    secure: config.cookieSecure,
    path: "/",
    maxAge: 0,
  });
}
