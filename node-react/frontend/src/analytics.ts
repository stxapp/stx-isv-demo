// Optional Google Analytics 4, on by default with a footer opt-out.
//
// - Off unless the backend sends a measurement id (GA_MEASUREMENT_ID, via
//   GET /api/app). With no id nothing here loads and nothing is sent.
// - With an id, gtag.js loads on the first visit. Consent Mode v2 denies every
//   ads storage type and grants analytics_storage only.
// - In the regions the deployment lists (GA_CONSENT_REQUIRED_REGIONS) a
//   visitor who has not chosen starts with analytics_storage denied: Google
//   gets cookieless pings only until they allow it.
// - The footer switch stores the choice in localStorage. After an opt-out
//   gtag.js is never loaded again and no events are sent.
// - Events carry no personal data: never a username, email, STX id or order id.

type ConsentChoice = "granted" | "denied";

const CONSENT_KEY = "sideline.analytics-consent";

export interface AnalyticsSettings {
  gaMeasurementId?: string | null;
  gaIgnoreReferrerDomains?: string[];
  gaLinkedDomains?: string[];
  gaConsentRequiredRegions?: string[];
}

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    [gaDisable: `ga-disable-${string}`]: boolean | undefined;
  }
}

let measurementId: string | null = null;
let settings: AnalyticsSettings = {};
let loaded = false;
let active = false;
// The last virtual page, sent once analytics starts.
let currentPage: { path: string; title: string } | null = null;
let firstPageSent = false;
const listeners = new Set<() => void>();

const DENY_ADS = { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" } as const;

function readChoice(): ConsentChoice | null {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    return v === "granted" || v === "denied" ? v : null;
  } catch {
    return null;
  }
}

function writeChoice(v: ConsentChoice): void {
  try {
    localStorage.setItem(CONSENT_KEY, v);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
}

// gtag.js reads each queued call as an `arguments` object, not an array.
function gtag(..._args: unknown[]): void;
function gtag(): void {
  window.dataLayer = window.dataLayer ?? [];
  // eslint-disable-next-line prefer-rest-params
  window.dataLayer.push(arguments);
}

/** The Consent Mode defaults for a stored choice, in the order they are sent. */
export function consentDefaults(choice: ConsentChoice | null, regions: string[] = []): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (choice === null && regions.length > 0) {
    out.push({ ...DENY_ADS, analytics_storage: "denied", region: [...regions] });
  }
  out.push({ ...DENY_ADS, analytics_storage: choice === "denied" ? "denied" : "granted" });
  return out;
}

/** True when the referrer's host is one of `domains` or a subdomain of one. */
export function referrerIgnored(referrer: string, domains: string[] = []): boolean {
  if (!referrer || domains.length === 0) return false;
  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** The `config` parameters for gtag, from the deployment's settings. */
export function configParams(s: AnalyticsSettings, referrer: string): Record<string, unknown> {
  // Page views are sent by hand (the app changes views without changing the
  // URL). The first one carries the full landing URL, so UTM tags count.
  const params: Record<string, unknown> = { send_page_view: false };
  if (referrerIgnored(referrer, s.gaIgnoreReferrerDomains)) params.ignore_referrer = true;
  if (s.gaLinkedDomains && s.gaLinkedDomains.length > 0) params.linker = { domains: [...s.gaLinkedDomains] };
  return params;
}

function load(id: string): void {
  if (loaded) return;
  loaded = true;
  gtag("js", new Date());
  gtag("config", id, configParams(settings, document.referrer));
  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  document.head.appendChild(s);
}

function start(): void {
  if (!measurementId) return;
  load(measurementId);
  active = true;
  if (currentPage) sendPage(currentPage.path, currentPage.title);
}

function sendPage(path: string, title: string): void {
  // The landing view keeps the real URL (with any utm_* query); later views
  // are virtual paths on the same origin.
  const location = firstPageSent ? `${window.location.origin}${path}` : window.location.href;
  firstPageSent = true;
  gtag("event", "page_view", { page_location: location, page_path: path, page_title: title });
}

function emit(): void {
  for (const l of listeners) l();
}

/** Called once with the GA settings from /api/app (no id: analytics off). */
export function initAnalytics(s: AnalyticsSettings): void {
  measurementId = s.gaMeasurementId ?? null;
  settings = s;
  if (measurementId) {
    window.gtag = gtag;
    const choice = readChoice();
    for (const d of consentDefaults(choice, s.gaConsentRequiredRegions)) gtag("consent", "default", d);
    if (choice === "denied") window[`ga-disable-${measurementId}`] = true;
    else start();
  }
  emit();
}

export function analyticsConfigured(): boolean {
  return measurementId !== null;
}

export function consentChoice(): ConsentChoice | null {
  return readChoice();
}

/** The footer switch: "denied" opts out, "granted" allows again. */
export function setConsent(choice: ConsentChoice): void {
  if (!measurementId) return;
  writeChoice(choice);
  window[`ga-disable-${measurementId}`] = choice === "denied";
  gtag("consent", "update", { analytics_storage: choice });
  if (choice === "granted") start();
  else active = false;
  emit();
}

/** Re-render hook for the footer switch. */
export function onAnalyticsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A virtual page view ("/", "/orders", ...). Not sent after an opt-out. */
export function trackPage(path: string, title: string): void {
  currentPage = { path, title };
  if (active) sendPage(path, title);
}

export type AnalyticsEvent =
  | "sign_in"
  | "sign_in_start"
  | "link_start"
  | "link_success"
  | "link_error"
  | "order_place"
  | "order_cancel"
  | "api_calls_view"
  | "deposit_click"
  | "wallet_topup"
  | "popup_blocked"
  | "source_click";

/** A named event with non-personal parameters (counts, labels). */
export function track(name: AnalyticsEvent, params: Record<string, string | number> = {}): void {
  if (active) gtag("event", name, params);
}
