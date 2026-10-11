// Local session cookie helpers.
//
// The "session" here is purely the ISV app's own login state: an opaque id in
// an httpOnly cookie that keys the server-side token store. It is unrelated to
// STX's session; STX only ever sees bearer tokens.

import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { config } from "./config";

const COOKIE_NAME = "isv_sid";

// The id in the cookie, if it is one this app could have issued. Ids are
// base64url, so anything with another character is refused; that includes the
// placeholders the store gives signed-out users ("detached:...").
function cookieSession(c: Context): string | undefined {
  const value = getCookie(c, COOKIE_NAME);
  return value && /^[A-Za-z0-9_-]+$/.test(value) ? value : undefined;
}

function newSessionId(): string {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString("base64url");
}

// Returns the existing session id from the cookie, or mints one and sets it.
export function getOrCreateSession(c: Context): string {
  return cookieSession(c) ?? startSession(c);
}

// Give this browser a brand-new session id. Called at the moment someone is
// signed in, so the id in use after sign-in is never one that existed before
// it: a cookie planted in the browser beforehand ends up signed in to nothing
// (session fixation).
export function startSession(c: Context): string {
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
  return cookieSession(c);
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
