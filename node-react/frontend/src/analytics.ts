// Optional Google Analytics 4, with consent.
//
// - Off unless the backend sends a measurement id (GA_MEASUREMENT_ID, via
//   GET /api/app). With no id nothing here loads and nothing is sent.
// - Nothing loads until the visitor accepts in the consent banner. On accept,
//   Consent Mode v2 starts with every storage type denied, then grants
//   analytics_storage only (never ads), and gtag.js loads from Google.
// - The choice is remembered in localStorage; the footer's "Usage statistics"
//   reopens it. Declining after accepting denies storage again and stops events.
// - Events carry no personal data: never a username, email, STX id or order id.

type ConsentChoice = "granted" | "denied";

const CONSENT_KEY = "sideline.analytics-consent";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

let measurementId: string | null = null;
let loaded = false;
let active = false;
// The last virtual page, sent once analytics starts.
let currentPage: { path: string; title: string } | null = null;
let firstPageSent = false;
const listeners = new Set<() => void>();

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

function load(id: string): void {
  if (loaded) return;
  loaded = true;
  window.gtag = gtag;
  gtag("consent", "default", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: "denied",
  });
  gtag("consent", "update", { analytics_storage: "granted" });
  gtag("js", new Date());
  // Page views are sent by hand (the app changes views without changing the
  // URL). The first one carries the full landing URL, so UTM tags count.
  gtag("config", id, { send_page_view: false });
  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  document.head.appendChild(s);
}

function start(): void {
  if (!measurementId) return;
  if (loaded) gtag("consent", "update", { analytics_storage: "granted" });
  else load(measurementId);
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

/** Called once with the id from /api/app (null: analytics off). */
export function initAnalytics(id: string | null | undefined): void {
  measurementId = id ?? null;
  if (measurementId && readChoice() === "granted") start();
  emit();
}

export function analyticsConfigured(): boolean {
  return measurementId !== null;
}

export function consentChoice(): ConsentChoice | null {
  return readChoice();
}

export function setConsent(choice: ConsentChoice): void {
  writeChoice(choice);
  if (choice === "granted") start();
  else if (active) {
    gtag("consent", "update", { analytics_storage: "denied" });
    active = false;
  }
  emit();
}

/** Re-render hook for the banner. */
export function onAnalyticsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A virtual page view ("/", "/orders", ...). Sent only with consent. */
export function trackPage(path: string, title: string): void {
  currentPage = { path, title };
  if (active) sendPage(path, title);
}

export type AnalyticsEvent =
  | "sign_in"
  | "link_start"
  | "link_success"
  | "link_error"
  | "order_place"
  | "order_cancel"
  | "api_calls_view"
  | "deposit_click"
  | "source_click";

/** A named event with non-personal parameters (counts, labels). */
export function track(name: AnalyticsEvent, params: Record<string, string | number> = {}): void {
  if (active) gtag("event", name, params);
}
