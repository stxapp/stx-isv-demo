// The login-mode switch. LOGIN_MODE picks one of three ways people get into the
// app, and each lives in its own folder:
//
//   own     ./own/     the app has its own login, then the user links their STX account
//   stx     ./stx/     people register or log in with their STX account
//   vendor  ./vendor/  the app's login is a login service that offers STX as an option
//
// Everything after sign-in (wallet, orders, live feeds) is the same code in
// every mode: each mode ends with one of the app's users on the browser session
// and STX tokens stored against that user.

import { Hono } from "hono";
import { config, type LoginMode, type OwnLogin } from "../config";
import { ownLoginRoutes } from "./own";
import { stxLoginRoutes } from "./stx";
import { vendorLoginRoutes, vendorSignOutUrl } from "./vendor";

// The routes of one login mode, mounted at the root by index.ts.
export function loginRoutes(mode: LoginMode = config.login.mode, own: OwnLogin = config.login.own): Hono {
  switch (mode) {
    case "own":
      return ownLoginRoutes(own);
    case "stx":
      return stxLoginRoutes();
    case "vendor":
      return vendorLoginRoutes();
  }
}

// Every path a login mode can own. index.ts answers the ones the configured
// mode did not mount with a 404, so a request for another mode's route is told
// so instead of falling through to the page.
export const LOGIN_PATHS = [
  "/api/login",
  "/api/login/privy",
  "/login",
  "/callback",
  "/auth/stx/start",
  "/auth/stx/callback",
  "/auth/vendor/start",
  "/auth/vendor/callback",
] as const;

// What the browser needs to draw the right sign-in (GET /api/app). No secrets.
export function publicLogin() {
  const { mode, own } = config.login;
  return {
    mode,
    // `own` mode: which login the app uses.
    own: mode === "own" ? own : null,
    // `own` + `privy`: the Privy App ID, which is public.
    privyAppId: mode === "own" && own === "privy" ? config.privyAppId : null,
    // `vendor` mode: the service's name for the button.
    vendorName: mode === "vendor" ? config.vendor.name : null,
  };
}

// After signing out of the app, where the browser should go so the login
// behind it signs out too. Only `vendor` mode has one.
export async function signOutUrl(): Promise<string | null> {
  return config.login.mode === "vendor" ? vendorSignOutUrl() : null;
}
