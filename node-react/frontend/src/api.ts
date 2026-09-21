// Thin client for the ISV backend. Every call sends the session cookie
// (`credentials: "include"`) so the backend can attach the right user's token,
// and carries `?app=<id>` identifying the ISV app profile the request is for.

const BACKEND = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8787";

// Origin the backend is served from. In a single-origin deploy this is the page
// origin; in split dev it is the backend port (:8787). The OAuth popup relays
// its result via postMessage FROM this origin, so App.tsx trusts it alongside
// the page origin. Resolves an empty/relative VITE_BACKEND_URL to the page.
export const BACKEND_ORIGIN = ((): string => {
  try {
    return new URL(BACKEND, window.location.href).origin;
  } catch {
    return window.location.origin;
  }
})();

// The active ISV app profile. Set once the profiles load / the user switches;
// every /api call and the /login redirect carry it.
let activeApp = "heater";
export function setActiveApp(id: string): void {
  activeApp = id;
}
export function getActiveApp(): string {
  return activeApp;
}

function withApp(path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}app=${encodeURIComponent(activeApp)}`;
}

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
  // link/session lapsed) — surfaced as a clear "connect STX" state, not a raw code.
  get notLinked(): boolean {
    return this.status === 401 && errCode(this.body) === "not_linked";
  }

  // Prefer STX's own message. On a 422 the backend forwards STX's rejection as
  // `{error:"<reason>"}` (price out of range, market closed, insufficient
  // balance…); show that instead of a bare status.
  static describe(status: number, body: unknown): string {
    const code = errCode(body);
    if (status === 401 || code === "not_linked") return "Your STX account isn’t connected.";
    if (code && code !== "not_linked") return code;
    const msg = body && typeof body === "object" ? (body as Record<string, unknown>).message : null;
    if (typeof msg === "string" && msg) return msg;
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
  enabled: boolean;
  isDefault: boolean;
}

export interface DemoUser {
  id: string;
  name: string;
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

export interface AppsResponse {
  apps: PublicApp[];
  defaultAppId: string;
}

export interface WalletState {
  app: string;
  heater: { label: string; walletCents: number; walletDollars: string; heldBy: string };
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
}

// Run the OAuth account-linking flow for the active app in a POPUP, so the
// member stays on the ISV's own page (the brand never navigates away). The
// popup is a top-level window on the STX origin, so STX login/consent is
// first-party there — cookies and CSRF work with no cross-site weakening, and
// X-Frame-Options (which would block an iframe) does not apply to a popup.
// /callback relays the result back via postMessage and closes itself
// (see the message listener in App.tsx). If the browser blocks the popup, fall
// back to a full-page redirect so linking still works.
// Open an STX flow (link, deposit, …) in a centered popup so the ISV brand page
// stays put. Open a BLANK popup first, straight from the click gesture, then
// navigate it: opening a sized window directly at a URL that 302s to another
// origin is what pop-up blockers target, whereas about:blank from a gesture is
// reliably allowed. Only if even that is blocked do we fall back to a redirect.
export function openStxPopup(url: string, name: string, size?: { w: number; h: number }): void {
  const w = size?.w ?? 480;
  const h = size?.h ?? 720;
  const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
  const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
  const popup = window.open(
    "about:blank",
    name,
    `width=${w},height=${h},left=${left},top=${top},resizable,scrollbars`,
  );
  if (!popup) {
    window.location.href = url;
    return;
  }
  popup.location.href = url;
  popup.focus();
}

// Login/consent is a tall, narrow form; the deposit page (card form + methods)
// wants a bit more room. Callers size each popup for its content.
export function startLink(): void {
  openStxPopup(`${BACKEND}/login?app=${encodeURIComponent(activeApp)}`, "stx_link", { w: 460, h: 720 });
}

// URL of the member's live SSE feed for a given app (see LiveFeed / backend
// /api/stream). Same-origin, so EventSource carries the session cookie.
export function liveStreamUrl(appId: string): string {
  return `${BACKEND}/api/stream?app=${encodeURIComponent(appId)}`;
}

export const api = {
  apps: () => req<AppsResponse>("/api/apps"),
  me: () => req<MeState>(withApp("/api/me")),
  login: (name?: string) =>
    req<{ user: DemoUser }>(withApp("/api/login"), {
      method: "POST",
      body: JSON.stringify({ name: name ?? "" }),
    }),
  signout: () => req<{ ok: boolean }>(withApp("/api/signout"), { method: "POST" }),
  unlink: () => req<{ ok: boolean }>(withApp("/api/unlink"), { method: "POST" }),
  wallet: () => req<WalletState>(withApp("/api/wallet")),
  orders: () => req<unknown>(withApp("/api/orders")),
  trades: () => req<unknown>(withApp("/api/trades")),
  settlements: () => req<unknown>(withApp("/api/settlements")),
  placeOrder: (order: unknown) =>
    req<unknown>(withApp("/api/orders"), { method: "POST", body: JSON.stringify(order) }),
  placeBatch: (orders: unknown[]) =>
    req<unknown>(withApp("/api/orders/batch"), { method: "POST", body: JSON.stringify({ orders }) }),
  cancelOrder: (id: string) =>
    req<unknown>(withApp(`/api/orders/${encodeURIComponent(id)}`), { method: "DELETE" }),
  // The activity panel shows this app's calls; pass scoped=false for all apps.
  activity: (scoped = true) =>
    req<{ activity: ActivityRecord[] }>(scoped ? withApp("/api/activity") : "/api/activity"),
};
