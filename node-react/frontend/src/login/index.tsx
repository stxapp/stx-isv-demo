// The login-mode switch for the browser. The backend says which mode this
// deployment runs (GET /api/app, from LOGIN_MODE), and each mode's sign-in UI
// lives in its own folder:
//
//   own     ./own/     the app has its own login (Privy, or the mock), then the user links their STX account
//   stx     ./stx/     people register or log in with their STX account
//   vendor  ./vendor/  the app's login is a login service that offers STX as an option
//
// Everything outside this folder is the same in every mode.

import { lazy, Suspense, type ReactNode } from "react";
import type { LoginInfo, PublicApp } from "../api";
import { MockSignIn } from "./own/MockSignIn";
import { privyActions } from "./own/privyBridge";
import { StxSignIn } from "./stx/StxSignIn";
import { VendorSignIn } from "./vendor/VendorSignIn";

// Privy's SDK is large and only one configuration uses it, so it is loaded on
// demand: the other modes never download it.
const PrivyRoot = lazy(() => import("./own/PrivySignIn").then((m) => ({ default: m.PrivyRoot })));
const PrivySignIn = lazy(() => import("./own/PrivySignIn").then((m) => ({ default: m.PrivySignIn })));

export const DEFAULT_LOGIN: LoginInfo = { mode: "own", own: "mock", privyAppId: null, vendorName: null };

// How long to wait before asking the backend for the mode again: 0.5s, 1s, 2s,
// then every 5s.
export function retryDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 5000);
}

function usesPrivy(login: LoginInfo): login is LoginInfo & { privyAppId: string } {
  return login.mode === "own" && login.own === "privy" && Boolean(login.privyAppId);
}

// Wraps the app in whatever the login needs around it (only Privy needs anything).
export function LoginProvider({ login, children }: { login: LoginInfo; children: ReactNode }) {
  if (!usesPrivy(login)) return <>{children}</>;
  return (
    <Suspense fallback={null}>
      <PrivyRoot appId={login.privyAppId}>{children}</PrivyRoot>
    </Suspense>
  );
}

// The sign-in card for the configured mode.
export function SignIn({ login, app, onSignedIn }: { login: LoginInfo; app: PublicApp; onSignedIn: () => void }) {
  if (login.mode === "stx") return <StxSignIn app={app} />;
  if (login.mode === "vendor") return <VendorSignIn app={app} vendorName={login.vendorName ?? "your login service"} />;
  if (usesPrivy(login)) {
    return (
      <Suspense fallback={null}>
        <PrivySignIn app={app} onSignedIn={onSignedIn} />
      </Suspense>
    );
  }
  return <MockSignIn app={app} onSignedIn={onSignedIn} />;
}

// Where "link your STX account" starts. In `stx` mode logging in and linking
// are one step, so linking again is logging in again.
export function linkPath(login: LoginInfo): string {
  return login.mode === "stx" ? "/auth/stx/start" : "/login";
}

// The words on the link button and under it.
export function linkCopy(login: LoginInfo, appName: string): { label: string; hint: string } {
  if (login.mode === "stx") {
    return {
      label: "Reconnect STX",
      hint: `Your STX connection ended. Log in to STX again to keep trading from ${appName}.`,
    };
  }
  return {
    label: "Link your STX account",
    hint: `Trade on STX from ${appName}. You'll sign in to STX and approve access.`,
  };
}

// The banner after a trip to STX or to the login service.
export function successMessage(login: LoginInfo, status: "linked" | "signed_in"): string {
  if (status === "signed_in") return "Signed in.";
  return login.mode === "stx" ? "Signed in and connected to STX." : "STX account linked.";
}

// After the app's own sign-out: sign out of the login behind it too. Privy has
// a call for it; a login service has a page to visit (`signOutUrl`, from the
// backend). Returns true when the browser is leaving the page.
export async function signOutOfLogin(signOutUrl: string | null | undefined): Promise<boolean> {
  // Best effort: the app's own sign-out is already done, so a failure here
  // must not leave the page looking signed in.
  await privyActions.logout?.().catch(() => {});
  if (signOutUrl) {
    window.location.assign(signOutUrl);
    return true;
  }
  return false;
}
