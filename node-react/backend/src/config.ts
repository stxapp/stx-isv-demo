// Configuration: everything comes strictly from the environment.
//
// Nothing about the STX endpoints is hard-coded: base URL, the OAuth endpoint
// paths, the requested scopes and the upstream API paths are all overridable so
// this same backend can point at a local server, a sandbox, or production
// without a code change.
//
// This demo presents as one fictional sports app that connects to STX as a
// confidential client. Its identity (client_id/secret/name/brand/scopes) is the
// app profile below, read from CLIENT_ID/CLIENT_SECRET/APP_*, and LOGIN_MODE
// picks how people get into it (see src/login/).

import { gaDomainsFrom, gaMeasurementIdFrom, gaRegionsFrom } from "./analytics";

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

// ---- App profile (one ISV app identity) ------------------------------------

// The ISV app's OAuth identity + demo-side branding and starting wallet: one
// OAuth client registered with STX.
export interface AppProfile {
  // Stable id used in URLs, the store, and the activity log (e.g. "sideline").
  id: string;
  // Human name shown in the UI ("Sideline").
  name: string;
  tagline: string;
  // CSS colour for the app's brand accent.
  brandColor: string;
  // OAuth client credentials for THIS app. The secret NEVER leaves the backend.
  clientId: string;
  clientSecret: string;
  // Must EXACTLY match one of the redirect URIs registered for this client;
  // STX exact-matches it (no prefix/wildcard) at both /authorize and /token.
  redirectUri: string;
  // Space-delimited scopes requested at /authorize for this app.
  scopes: string;
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

// This app's own public origin (e.g. https://sideline.example.com), with
// no trailing slash. Everything the app says about where it lives derives from
// it: the OAuth redirect URI, where /callback sends the browser, and the logo
// URL registered with the exchange. Moving the app to another host is this one
// env var (plus the redirect URI registered on the exchange's OAuth client).
const publicUrl = (optionalRaw("PUBLIC_URL") ?? "").replace(/\/+$/, "");

// The app ("Sideline"). Its client credentials are required.
const sideline: AppProfile = {
  id: optional("APP_ID", "sideline"),
  name: optional("APP_NAME", "Sideline"),
  tagline: optional("APP_TAGLINE", "Trade real sports markets, powered by the STX Exchange."),
  brandColor: optional("APP_BRAND_COLOR", "#3d8bff"),
  clientId: required("CLIENT_ID"),
  clientSecret: required("CLIENT_SECRET"),
  redirectUri: optional("REDIRECT_URI", publicUrl ? `${publicUrl}/callback` : "http://localhost:8787/callback"),
  scopes: optional("OAUTH_SCOPES", "profile.read balance.read portfolio.read orders.read orders.write"),
  startingWalletCents: parseCents("APP_WALLET_CENTS", 25_000), // $250.00
};

const stxBaseUrl = required("STX_BASE_URL").replace(/\/+$/, "");

export type LoginMode = "own" | "stx" | "vendor";
export type OwnLogin = "privy" | "mock";

// LOGIN_MODE picks how people get into the app. Unset means `own`.
function loginMode(): LoginMode {
  const raw = optional("LOGIN_MODE", "own").toLowerCase();
  if (raw === "own" || raw === "stx" || raw === "vendor") return raw;
  throw new Error(`LOGIN_MODE must be own, stx or vendor (got "${raw}").`);
}

export function withOpenId(scopes: string): string {
  const list = scopes.split(/\s+/).filter(Boolean);
  return (list.includes("openid") ? list : ["openid", ...list]).join(" ");
}

function vendorClientAuth(): "client_secret_basic" | "client_secret_post" {
  const raw = optional("VENDOR_CLIENT_AUTH", "client_secret_basic");
  if (raw === "client_secret_basic" || raw === "client_secret_post") return raw;
  throw new Error(`VENDOR_CLIENT_AUTH must be client_secret_basic or client_secret_post (got "${raw}").`);
}

// `vendor` mode needs the login service's settings.
if (loginMode() === "vendor") {
  required("VENDOR_ISSUER");
  required("VENDOR_CLIENT_ID");
  required("VENDOR_CLIENT_SECRET");
}

// OWN_LOGIN picks the app's own login in `own` mode. Unset means `privy` when
// the Privy keys are set and `mock` otherwise.
function ownLogin(): OwnLogin {
  const hasPrivy = optionalRaw("PRIVY_APP_ID") !== null && optionalRaw("PRIVY_APP_SECRET") !== null;
  const raw = optional("OWN_LOGIN", hasPrivy ? "privy" : "mock").toLowerCase();
  if (raw !== "privy" && raw !== "mock") throw new Error(`OWN_LOGIN must be privy or mock (got "${raw}").`);
  if (raw === "privy" && !hasPrivy && loginMode() === "own") {
    throw new Error("OWN_LOGIN=privy needs PRIVY_APP_ID and PRIVY_APP_SECRET.");
  }
  return raw;
}


export const config = {
  port: Number(optional("PORT", "8787")),

  // The STX exchange this demo integrates with. Your STX sandbox host, e.g.
  // https://stx-sandbox.example.com.
  stxBaseUrl,

  // The exchange's address as the BROWSER should see it: the deposit popup and
  // the exchange-served team and league logos. Defaults to STX_BASE_URL; set it
  // when the backend reaches the exchange on an internal address. Sent to the
  // browser at runtime (GET /api/app), so no frontend rebuild is needed.
  stxPublicUrl: (optionalRaw("STX_PUBLIC_URL") ?? stxBaseUrl).replace(/\/+$/, ""),

  // This app's own public origin ("" when unset, e.g. local dev).
  publicUrl,

  // Google Analytics 4 measurement id ("G-..."), or null: no analytics code
  // is loaded at all. Sent to the browser at runtime (GET /api/app).
  gaMeasurementId: gaMeasurementIdFrom(process.env.GA_MEASUREMENT_ID),
  // Optional GA settings, all empty by default. Referrers from these domains
  // (or their subdomains) are not counted as a traffic source.
  gaIgnoreReferrerDomains: gaDomainsFrom(process.env.GA_IGNORE_REFERRER_DOMAINS),
  // Cross-domain measurement: links to these hosts carry the GA client id.
  gaLinkedDomains: gaDomainsFrom(process.env.GA_LINKED_DOMAINS),
  // Regions (ISO 3166, e.g. GB, CA-QC) where analytics starts denied until
  // the visitor allows it.
  gaConsentRequiredRegions: gaRegionsFrom(process.env.GA_CONSENT_REQUIRED_REGIONS),

  // The one ISV app this backend presents as.
  app: sideline,

  // Where /callback sends the browser once tokens are stored server-side.
  frontendUrl: optional("FRONTEND_URL", publicUrl || "http://localhost:5173"),

  // OAuth + API endpoint paths, relative to stxBaseUrl. Overridable so the
  // demo is not tied to one server's routing.
  //
  // The real STX scope vocabulary is exactly:
  //   profile.read balance.read portfolio.read orders.read transfers.read orders.write terms.write
  // STX narrows the app's request to the intersection of the client's
  // registered scopes and what the member consents to. No scope moves money
  // (deposits / withdrawals / transfers are never delegable; `transfers.read` is
  // read-only).
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

  // How people get into the app (see src/login/). One setting, three modes:
  //   own     the app has its own login, then the user links their STX account
  //   stx     people register or log in with their STX account
  //   vendor  the app's login is a login service that offers STX as an option
  login: {
    mode: loginMode(),
    // `own` mode only: which login the app uses. `privy` (https://privy.io) is
    // what this demo happens to use; `mock` is a no-password stand-in.
    own: ownLogin(),
  },

  // `own` + `privy`: the App ID is public and sent to the browser
  // (GET /api/app); the secret stays here.
  privyAppId: optionalRaw("PRIVY_APP_ID") ?? null,
  privyAppSecret: optionalRaw("PRIVY_APP_SECRET") ?? null,

  // `stx` mode: the redirect URI registered on this app's STX client for
  // registering or logging in with an STX account (exact match). The address
  // the sign-in documents are read from is the exchange unless STX_ISSUER is set.
  stxLogin: {
    issuer: optional("STX_ISSUER", stxBaseUrl).replace(/\/+$/, ""),
    redirectUri: optional(
      "STX_LOGIN_REDIRECT_URI",
      publicUrl ? `${publicUrl}/auth/stx/callback` : "http://localhost:8787/auth/stx/callback",
    ),
  },

  // `vendor` mode: the login service, as generic OpenID Connect settings. Any
  // service that publishes /.well-known/openid-configuration works.
  vendor: {
    // Shown on the sign-in button ("Continue with <name>").
    name: optional("VENDOR_NAME", "your login service"),
    issuer: (optionalRaw("VENDOR_ISSUER") ?? "").replace(/\/+$/, ""),
    clientId: optionalRaw("VENDOR_CLIENT_ID") ?? "",
    clientSecret: optionalRaw("VENDOR_CLIENT_SECRET") ?? "",
    redirectUri: optional(
      "VENDOR_REDIRECT_URI",
      publicUrl ? `${publicUrl}/auth/vendor/callback` : "http://localhost:8787/auth/vendor/callback",
    ),
    // `openid` is always asked for: it is what makes the service return the
    // ID token that says who logged in.
    scopes: withOpenId(optional("VENDOR_SCOPES", "openid profile email")),
    // How the client secret is sent to the service's token endpoint.
    clientAuth: vendorClientAuth(),
    // Extra query parameters for the service's authorize URL, as a query
    // string. Many services take one that goes straight to a login option,
    // e.g. `connection=stx`.
    authorizeParams: optional("VENDOR_AUTHORIZE_PARAMS", ""),
    // Allow an http:// issuer (local development and tests only).
    allowInsecure: optional("VENDOR_ALLOW_INSECURE", "false") === "true",
  },

  // Cookie flags. Set COOKIE_SECURE=true behind HTTPS.
  cookieSecure: optional("COOKIE_SECURE", "false") === "true",
} as const;

// Resolve the app by id (absent means the app), or null for any other id.
// Callers treat a null as a 400 "unknown app".
export function getApp(id: string | undefined | null): AppProfile | null {
  if (!id || id === config.app.id) return config.app;
  return null;
}

export type Config = typeof config;
