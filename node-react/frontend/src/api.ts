// Thin client for the ISV backend. Every call sends the session cookie
// (`credentials: "include"`) so the backend can attach the right user's token.

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

export interface AppResponse {
  app: PublicApp;
  // The exchange's public origin (deposit popup, sport icons).
  stxPublicUrl?: string;
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
// (see the message listener in App.tsx). If the browser blocks the popup, fall
// back to a full-page redirect so linking still works.
// Open an STX flow (link, deposit, …) in a centered popup so the ISV brand page
// stays put. The popup is opened directly at the URL from the click gesture, so
// its first document is the STX page itself. (Opening about:blank and navigating
// it afterwards makes the popup start life on THIS app's origin; browsers with
// strict storage partitioning, Brave among them, can then split the STX session
// cookie between the login page and the post-login redirect, which strands the
// member on the STX home page instead of returning to consent.) If the browser
// blocks the popup, fall back to a full-page redirect so linking still works.
export function openStxPopup(url: string, name: string, size?: { w: number; h: number }): void {
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
    window.location.href = url;
    return;
  }
  popup.focus();
}

// Login/consent is a tall, narrow form; the deposit page (card form + methods)
// wants a bit more room. Callers size each popup for its content.
export function startLink(): void {
  openStxPopup(`${BACKEND}/login`, "stx_link", { w: 460, h: 720 });
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
  signout: () => req<{ ok: boolean }>("/api/signout", { method: "POST" }),
  unlink: () => req<{ ok: boolean }>("/api/unlink", { method: "POST" }),
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
