import { beforeEach, describe, expect, test } from "bun:test";

// Minimal browser globals: analytics.ts only touches localStorage, window,
// document.head and document.referrer.
const store = new Map<string, string>();
const scripts: { src: string }[] = [];
const g = globalThis as Record<string, unknown>;
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};
g.window = g;
g.document = {
  referrer: "",
  createElement: () => ({ async: false, src: "" }),
  head: { appendChild: (s: { src: string }) => void scripts.push(s) },
};
g.location = { href: "https://app.example/?utm_source=x", origin: "https://app.example" };

// A fresh module per test: its load/opt-out state is module-level.
let n = 0;
async function fresh() {
  return (await import(`./analytics.ts?case=${n++}`)) as typeof import("./analytics");
}

const ID = "G-TEST123";
const calls = () => ((g.dataLayer as IArguments[] | undefined) ?? []).map((a) => Array.from(a));

beforeEach(() => {
  store.clear();
  scripts.length = 0;
  delete g.dataLayer;
  delete g[`ga-disable-${ID}`];
});

describe("consentDefaults", () => {
  const ads = { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" };
  test("no choice and no regions: analytics granted", async () => {
    const a = await fresh();
    expect(a.consentDefaults(null, [])).toEqual([{ ...ads, analytics_storage: "granted" }]);
  });
  test("no choice with regions: a denied regional default first", async () => {
    const a = await fresh();
    expect(a.consentDefaults(null, ["GB", "CA-QC"])).toEqual([
      { ...ads, analytics_storage: "denied", region: ["GB", "CA-QC"] },
      { ...ads, analytics_storage: "granted" },
    ]);
  });
  test("a stored choice wins over the regions", async () => {
    const a = await fresh();
    expect(a.consentDefaults("granted", ["GB"])).toEqual([{ ...ads, analytics_storage: "granted" }]);
    expect(a.consentDefaults("denied", ["GB"])).toEqual([{ ...ads, analytics_storage: "denied" }]);
  });
});

describe("configParams", () => {
  test("defaults: manual page views only", async () => {
    const a = await fresh();
    expect(a.configParams({}, "https://www.example.com/")).toEqual({ send_page_view: false });
  });
  test("ignore_referrer for listed domains and their subdomains only", async () => {
    const a = await fresh();
    const s = { gaIgnoreReferrerDomains: ["example.com"] };
    expect(a.configParams(s, "https://example.com/x").ignore_referrer).toBe(true);
    expect(a.configParams(s, "https://docs.example.com/").ignore_referrer).toBe(true);
    expect(a.configParams(s, "https://notexample.com/").ignore_referrer).toBeUndefined();
    expect(a.configParams(s, "").ignore_referrer).toBeUndefined();
  });
  test("linker only when linked domains are set", async () => {
    const a = await fresh();
    expect(a.configParams({ gaLinkedDomains: [] }, "").linker).toBeUndefined();
    expect(a.configParams({ gaLinkedDomains: ["a.example", "b.example"] }, "").linker).toEqual({
      domains: ["a.example", "b.example"],
    });
  });
});

describe("initAnalytics", () => {
  test("no id: nothing loads or is queued", async () => {
    const a = await fresh();
    a.initAnalytics({ gaMeasurementId: null, gaConsentRequiredRegions: ["GB"] });
    a.trackPage("/", "Markets");
    expect(a.analyticsConfigured()).toBe(false);
    expect(scripts).toHaveLength(0);
    expect(calls()).toEqual([]);
  });

  test("first visit loads gtag.js, then opt-out and allow", async () => {
    const a = await fresh();
    a.initAnalytics({ gaMeasurementId: ID, gaConsentRequiredRegions: ["GB"], gaLinkedDomains: ["b.example"] });
    a.trackPage("/", "Markets");
    expect(scripts.map((s) => s.src)).toEqual([`https://www.googletagmanager.com/gtag/js?id=${ID}`]);
    const c = calls();
    expect(c.map((x) => x[0])).toEqual(["consent", "consent", "js", "config", "event"]);
    expect((c[0]![2] as { region: string[] }).region).toEqual(["GB"]);
    expect(c[3]).toEqual(["config", ID, { send_page_view: false, linker: { domains: ["b.example"] } }]);

    a.setConsent("denied");
    expect(store.get("sideline.analytics-consent")).toBe("denied");
    expect(g[`ga-disable-${ID}`]).toBe(true);
    expect(calls().at(-1)).toEqual(["consent", "update", { analytics_storage: "denied" }]);
    const before = calls().length;
    a.trackPage("/orders", "My orders");
    a.track("order_place", { count: 1 });
    expect(calls()).toHaveLength(before);

    a.setConsent("granted");
    expect(store.get("sideline.analytics-consent")).toBe("granted");
    expect(g[`ga-disable-${ID}`]).toBe(false);
    expect(scripts).toHaveLength(1);
    a.track("order_place", { count: 1 });
    expect(calls().at(-1)).toEqual(["event", "order_place", { count: 1 }]);
  });

  test("after an opt-out gtag.js never loads; allow loads it", async () => {
    store.set("sideline.analytics-consent", "denied");
    const a = await fresh();
    a.initAnalytics({ gaMeasurementId: ID, gaConsentRequiredRegions: ["GB"] });
    a.trackPage("/", "Markets");
    a.track("sign_in");
    expect(scripts).toHaveLength(0);
    expect(g[`ga-disable-${ID}`]).toBe(true);
    // One default only (no regional one: the visitor has chosen), and denied.
    expect(calls()).toEqual([
      ["consent", "default", { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "denied" }],
    ]);

    a.setConsent("granted");
    expect(scripts).toHaveLength(1);
    expect(calls().map((x) => x.slice(0, 2))).toContainEqual(["event", "page_view"]);
  });
});
