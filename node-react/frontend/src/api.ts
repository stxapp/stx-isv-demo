// Thin client for the ISV backend. Every call sends the session cookie
// (`credentials: "include"`) so the backend can attach the right user's token.

import { track } from "./analytics";

export const BACKEND = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8787";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const text = await res.text();
  const body = text ? safeParse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, body);
  }
  return body as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(ApiError.describe(status, body));
  }

  // A 401 with `{error:"not_linked"}` means the member has not linked STX (or the
  // link/session lapsed): surfaced as a clear "connect STX" state, not a raw code.
  get notLinked(): boolean {
    return this.status === 401 && errCode(this.body) === "not_linked";
  }

  // Prefer STX's own message. On a 422 the backend forwards STX's rejection as
  // `{error:"<reason>"}` (price out of range, market closed, insufficient
  // balance…); show that instead of a bare status.
  static describe(status: number, body: unknown): string {
    const code = errCode(body);
    // A 401 from an STX proxy is a missing link; other 401s say what they are.
    if (code === "not_linked" || (status === 401 && !code)) return "Your STX account isn’t connected.";
    // The app's own errors carry a sentence for the person (`message`) next to
    // the code; STX's forwarded rejections carry only the reason as `error`.
    const msg = body && typeof body === "object" ? (body as Record<string, unknown>).message : null;
    if (typeof msg === "string" && msg) return msg;
    if (code) return code;
    return `API error ${status}`;
  }
}

function errCode(body: unknown): string | null {
  if (body && typeof body === "object") {
    const e = (body as Record<string, unknown>).error;
    if (typeof e === "string") return e;
  }
  return null;
}

// ---- Types (mirror the backend responses) ----------------------------------

export interface PublicApp {
  id: string;
  name: string;
  tagline: string;
  brandColor: string;
  scopes: string[];
}

export interface DemoUser {
  id: string;
  name: string;
  // Their email, when the login gave one.
  email?: string | null;
  walletCents: number;
  walletDollars: string;
}

export interface LinkState {
  connected: boolean;
  scopes: string[];
  linkedAt: number | null;
}

export interface MeState {
  app: PublicApp;
  user: DemoUser | null;
  link: LinkState;
}

// How people get into this deployment (the backend's LOGIN_MODE); see login/.
export interface LoginInfo {
  mode: "own" | "stx" | "vendor";
  // `own` mode: which login the app uses.
  own: "privy" | "mock" | null;
  // `own` + `privy`: the Privy App ID.
  privyAppId: string | null;
  // `vendor` mode: the login service's name, for the button.
  vendorName: string | null;
}

export interface AppResponse {
  app: PublicApp;
  login?: LoginInfo;
  // The exchange's public origin (deposit popup, sport icons).
  stxPublicUrl?: string;
  // Google Analytics 4 id when the deployment enables it, else null.
  gaMeasurementId?: string | null;
  // Optional GA settings (see analytics.ts); empty or absent when unset.
  gaIgnoreReferrerDomains?: string[];
  gaLinkedDomains?: string[];
  gaConsentRequiredRegions?: string[];
}

export interface WalletState {
  app: string;
  isv: { label: string; walletCents: number; walletDollars: string; heldBy: string };
  stx: {
    linked: boolean;
    heldBy?: string;
    status?: number;
    balance: unknown;
    cashCents: number | null;
    cashDollars?: string | null;
  };
  combinedCents: number | null;
  combinedDollars?: string | null;
}

export interface ActivityRecord {
  id: number;
  ts: number;
  appId: string | null;
  method: string;
  path: string;
  status: number | null;
  note: string | null;
  // The @stxapp/stx-typescript call that produced the row, as code. Null on old rows.
  sdkCall: string | null;
  // Whether the backend stored the (redacted) request and response for the row.
  // Absent on a backend that predates details.
  hasDetail?: boolean;
}

// One side of an activity detail. `body` is JSON (redacted, long lists cut to
// their first items) or, when `truncated`, the first 20 KB as text.
export interface ActivityBody {
  body?: unknown;
  truncated?: boolean;
  size?: number;
}

export interface ActivityDetail {
  request?: { method: string; path: string; query?: Record<string, unknown> } & ActivityBody;
  response?: { status: number | null; summary?: string } & ActivityBody;
  note?: string;
}

// Run the OAuth account-linking flow for the active app in a POPUP, so the
// member stays on the ISV's own page (the brand never navigates away). The
// popup is a top-level window on the STX origin, so STX login/consent is
// first-party there: cookies and CSRF work with no cross-site weakening, and
// X-Frame-Options (which would block an iframe) does not apply to a popup.
// /callback relays the result back via postMessage and closes itself
// (see the message listener in App.tsx).
// Open an STX flow (link, deposit, …) in a centered popup so the ISV brand page
// stays put. The popup is opened directly at the URL from the click gesture, so
// its first document is the STX page itself. (Opening about:blank and navigating
// it afterwards makes the popup start life on THIS app's origin; browsers with
// strict storage partitioning, Brave among them, can then split the STX session
// cookie between the login page and the post-login redirect, which strands the
// member on the STX home page instead of returning to consent.) If the browser
// blocks the popup, the page stays put and PopupBlocked offers to open it again
// (a second click is a fresh gesture, which popup blockers let through).
export interface StxPopupRequest {
  url: string;
  name: string;
  size?: { w: number; h: number };
}
export const POPUP_BLOCKED_EVENT = "stx-popup-blocked";

export function openStxPopup(url: string, name: string, size?: { w: number; h: number }): boolean {
  const w = size?.w ?? 480;
  const h = size?.h ?? 720;
  const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
  const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
  const popup = window.open(
    url,
    name,
    `width=${w},height=${h},left=${left},top=${top},resizable,scrollbars`,
  );
  if (!popup) {
    const detail: StxPopupRequest = { url, name, size };
    window.dispatchEvent(new CustomEvent(POPUP_BLOCKED_EVENT, { detail }));
    return false;
  }
  popup.focus();
  return true;
}

// Login/consent is a tall, narrow form; the deposit page (card form + methods)
// wants a bit more room. Callers size each popup for its content.
// How the user signed in to the app's own login, passed to STX as hints:
// `connection` goes straight to the same provider, `login_hint` preselects the
// account. Set after a Privy sign-in; empty for the mock sign-in.
export interface ConnectHint {
  connection: string | null;
  loginHint: string | null;
}
let connectHint: ConnectHint = { connection: null, loginHint: null };

// Where linking starts on the backend: "/login", or the STX login itself when
// logging in and linking are one step (set from the login mode, see login/).
let linkStartPath = "/login";
export function setLinkStartPath(path: string): void {
  linkStartPath = path;
}
export function setConnectHint(hint: ConnectHint): void {
  connectHint = hint;
}

// Phones get a full-page redirect instead of a popup; /callback sends the
// member back here when there is no opener.
function smallScreen(): boolean {
  return window.matchMedia?.("(max-width: 640px)").matches ?? false;
}

export function linkUrl(hint: ConnectHint = connectHint): string {
  const q = new URLSearchParams();
  if (hint.connection) q.set("connection", hint.connection);
  if (hint.loginHint) q.set("login_hint", hint.loginHint);
  const qs = q.toString();
  return `${BACKEND}${linkStartPath}${qs ? `?${qs}` : ""}`;
}

export function startLink(): void {
  track("link_start");
  const url = linkUrl();
  if (smallScreen()) window.location.assign(url);
  else openStxPopup(url, "stx_link", { w: 460, h: 720 });
}

// URL of the member's live SSE feed (see LiveFeed / backend /api/stream).
// Same-origin, so EventSource carries the session cookie.
export function liveStreamUrl(): string {
  return `${BACKEND}/api/stream`;
}

export const api = {
  app: () => req<AppResponse>("/api/app"),
  // `verify`: the backend proves a stored link still works with one STX call
  // (a grant revoked at STX then reads as not linked).
  me: (verify = false) => req<MeState>(verify ? "/api/me?verify=1" : "/api/me"),
  login: (name?: string) =>
    req<{ user: DemoUser }>("/api/login", {
      method: "POST",
      body: JSON.stringify({ name: name ?? "" }),
    }),
  // Sign in with the app's own login (Privy): the server verifies the token.
  privyLogin: (accessToken: string) =>
    req<{ user: DemoUser; connectHint: ConnectHint }>("/api/login/privy", {
      method: "POST",
      body: JSON.stringify({ accessToken }),
    }),
  // `signOutUrl`: where to go next so the login behind the app signs out too.
  signout: () => req<{ ok: boolean; signOutUrl?: string | null }>("/api/signout", { method: "POST" }),
  unlink: () => req<{ ok: boolean }>("/api/unlink", { method: "POST" }),
  // Demo top-up of the app's own wallet (no payment; STX funds are added at STX).
  addFunds: (cents: number) =>
    req<{ user: DemoUser }>("/api/wallet/deposit", { method: "POST", body: JSON.stringify({ cents }) }),
  // `live`: the browser holds the live feed, so the backend never calls STX for
  // the balance here (the STX cash comes from the stream).
  wallet: (live = false) => req<WalletState>(live ? "/api/wallet?stx=live" : "/api/wallet"),
  orders: () => req<unknown>("/api/orders"),
  trades: () => req<unknown>("/api/trades"),
  settlements: () => req<unknown>("/api/settlements"),
  placeOrder: (order: unknown) =>
    req<unknown>("/api/orders", { method: "POST", body: JSON.stringify(order) }),
  placeBatch: (orders: unknown[]) =>
    req<unknown>("/api/orders/batch", { method: "POST", body: JSON.stringify({ orders }) }),
  cancelOrder: (id: string) =>
    req<unknown>(`/api/orders/${encodeURIComponent(id)}`, { method: "DELETE" }),
  activity: () => req<{ activity: ActivityRecord[] }>("/api/activity"),
  // The redacted request/response behind one activity row; null for old rows.
  activityDetail: (id: number) => req<{ detail: ActivityDetail | null }>(`/api/activity/${id}/detail`),
};
