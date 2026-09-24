// Configuration — everything comes strictly from the environment.
//
// Nothing about the STX endpoints is hard-coded: base URL, the OAuth endpoint
// paths, the requested scopes and the upstream API paths are all overridable so
// this same backend can point at a local server, a preview, or production
// without a code change.
//
// This demo presents as an ISV app called "Heater" that connects to STX. The
// app's identity (client_id/secret/name/brand/scopes) is read from the
// environment, so pointing the demo at a different ISV is a matter of new
// credentials, not a code change.

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

function optionalRaw(name: string): string | null {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : null;
}

// ---- App profile (the ISV app identity) ------------------------------------

// The ISV app's OAuth identity plus the demo-side branding and starting wallet.
// The app is an OAuth client registered with STX; connecting yields a grant with
// its own token set, revocable on its own.
export interface AppProfile {
  // Stable id used in URLs, the store, and the activity log (e.g. "heater").
  id: string;
  // Human name shown in the UI ("Heater").
  name: string;
  tagline: string;
  // CSS colour for the app's brand accent.
  brandColor: string;
  // OAuth client credentials for the app. The secret NEVER leaves the backend.
  clientId: string;
  clientSecret: string;
  // Must EXACTLY match one of the redirect URIs registered for this client;
  // STX exact-matches it (no prefix/wildcard) at both /authorize and /token.
  redirectUri: string;
  // Space-delimited scopes requested at /authorize.
  scopes: string;
  // Whether the app's own client credentials are configured.
  enabled: boolean;
  // Starting balance of the app's OWN wallet (the ISV-held balance), in cents.
  // This is the demo's own money, entirely separate from any STX balance.
  startingWalletCents: number;
}

function parseCents(name: string, fallback: number): number {
  const raw = optionalRaw(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// The ISV app ("Heater"). Its client credentials are required.
const heater: AppProfile = {
  id: optional("APP_ID", "heater"),
  name: optional("APP_NAME", "Heater"),
  tagline: optional("APP_TAGLINE", "Trade real sports markets, powered by the STX Exchange."),
  brandColor: optional("APP_BRAND_COLOR", "#ff5a1f"),
  clientId: required("CLIENT_ID"),
  clientSecret: required("CLIENT_SECRET"),
  redirectUri: required("REDIRECT_URI"),
  scopes: optional("OAUTH_SCOPES", "profile.read balance.read portfolio.read orders.read orders.write"),
  enabled: true,
  startingWalletCents: parseCents("APP_WALLET_CENTS", 25_000), // $250.00
};

const appList = [heater];
const apps: Record<string, AppProfile> = Object.fromEntries(appList.map((a) => [a.id, a]));

export const config = {
  port: Number(optional("PORT", "8787")),

  // The STX exchange this demo integrates with. Point at a preview like
  // https://<your-stx-host>, or http://localhost:4000 locally.
  stxBaseUrl: required("STX_BASE_URL").replace(/\/+$/, ""),

  // The ISV app profile.
  apps,
  appList,
  defaultAppId: heater.id,

  // Where /callback sends the browser once tokens are stored server-side.
  frontendUrl: optional("FRONTEND_URL", "http://localhost:5173"),

  // OAuth + API endpoint paths, relative to stxBaseUrl. These belong to the
  // exchange. Overridable so the demo is not tied to one server's routing.
  //
  // The real STX scope vocabulary is exactly:
  //   profile.read balance.read portfolio.read orders.read transfers.read orders.write terms.write
  // STX narrows the request to the intersection of the client's registered
  // scopes and what the member consents to. No scope moves money (deposits /
  // withdrawals / transfers are never delegable; `transfers.read` is read-only).
  paths: {
    authorize: optional("STX_AUTHORIZE_PATH", "/oauth/authorize"),
    token: optional("STX_TOKEN_PATH", "/oauth/token"),
    revoke: optional("STX_REVOKE_PATH", "/oauth/revoke"),
    // Cash balance for the account (scope `balance.read`). Identity (`/api/v1/me`,
    // scope `profile.read`) is a separate endpoint if you want the "who am I" view.
    balance: optional("STX_BALANCE_PATH", "/api/v1/account/balance"),
    orders: optional("STX_ORDERS_PATH", "/api/v1/orders"),
    // Public market catalog (scope `market_data` on an app token). The market
    // WebSocket channels (ticker/trades/orderbook/market_stats) live on the same
    // `/socket` endpoint and are gated by the same scope.
    markets: optional("STX_MARKETS_PATH", "/api/v1/markets"),
    // The member's fills (scope `orders.read`) and settled positions (scope `portfolio.read`).
    trades: optional("STX_TRADES_PATH", "/api/v1/fills"),
    settlements: optional("STX_SETTLEMENTS_PATH", "/api/v1/portfolio/settlements"),
  },

  // SQLite file, mounted on a volume in Docker so state survives a restart.
  dbPath: optional("DB_PATH", "./data/isv.sqlite"),

  // Cookie flags. Set COOKIE_SECURE=true behind HTTPS.
  cookieSecure: optional("COOKIE_SECURE", "false") === "true",
} as const;

// Resolve an app profile by id, or null if unknown. Callers treat a null as a
// 400 "unknown app".
export function getApp(id: string | undefined | null): AppProfile | null {
  if (!id) return config.apps[config.defaultAppId] ?? null;
  return config.apps[id] ?? null;
}

export type Config = typeof config;
