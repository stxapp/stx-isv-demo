// Unit tests for the recent-trades mapping: a market's REST `recent_trades` ->
// rows in the `trades` channel's shape, so the tape renders both the same way.

import { describe, expect, test } from "bun:test";

// Same env block as the other test files (config is built once per process).
process.env.STX_BASE_URL = "https://stx.example.com";
process.env.CLIENT_ID = "sideline-test-client-id";
process.env.CLIENT_SECRET = "sideline-test-client-secret";
process.env.REDIRECT_URI = "http://localhost:8787/callback";
process.env.OAUTH_SCOPES = "profile.read balance.read portfolio.read orders.read orders.write";
process.env.DB_PATH = ":memory:";

const { toTradeRows, fetchAllMarkets, CatalogCache, CATALOG_QUERY, MAX_MARKETS, PAGE_SIZE } = await import(
  "./marketCatalog"
);
type CatalogResult = Awaited<ReturnType<typeof fetchAllMarkets>>;

const M = "0fc2c8e3-fc20-44f6-a621-000aae3dc7a2";

describe("toTradeRows", () => {
  test("maps the liquidity taker to the channel's buy/sell and sorts newest first", () => {
    const rows = toTradeRows(M, [
      { timestamp: "2026-09-28T02:42:01.391250Z", quantity: "2.00", price: "0.4500", liquidity_taker: "seller", timestamp_us: 1790563321391250 },
      { timestamp: "2026-09-28T02:59:20.921275Z", quantity: "3.00", price: "0.5500", liquidity_taker: "buyer", timestamp_us: 1790564360921275 },
    ]);
    expect(rows).toEqual([
      { market_id: M, price: "0.5500", quantity: "3.00", action: "buy", timestamp: "2026-09-28T02:59:20.921275Z", timestamp_us: 1790564360921275 },
      { market_id: M, price: "0.4500", quantity: "2.00", action: "sell", timestamp: "2026-09-28T02:42:01.391250Z", timestamp_us: 1790563321391250 },
    ]);
  });

  test("derives timestamp_us from the ISO time when absent", () => {
    const [row] = toTradeRows(M, [{ timestamp: "2026-09-28T00:00:00Z", quantity: "1.00", price: "0.5000", liquidity_taker: "buyer" }]);
    expect(row?.timestamp_us).toBe(Date.parse("2026-09-28T00:00:00Z") * 1000);
  });

  test("drops rows without a price or time, and tolerates a missing list", () => {
    expect(toTradeRows(M, [{ quantity: "1.00" }, { price: "0.5", timestamp: "" }])).toEqual([]);
    expect(toTradeRows(M, null)).toEqual([]);
    expect(toTradeRows(M, undefined)).toEqual([]);
  });
});

// A raw REST market with just the fields the walk and the mapping read.
function rawMarket(i: number): Record<string, unknown> {
  return { market_id: `m-${i}`, status: "open", price: "0.5000", max_price: "1.0000" };
}

// A stub of the SDK's `iterMarkets`: yields `count` markets, page by page, and
// throws after `failAfter` markets when set (as the SDK does when a later page
// errors). Records the query it was given and how many markets it yielded.
function stubClient(count: number, failAfter?: number) {
  const seen = { query: undefined as unknown, yielded: 0 };
  return {
    seen,
    client: {
      async *iterMarkets(query: typeof CATALOG_QUERY) {
        seen.query = query;
        for (let i = 0; i < count; i++) {
          if (failAfter !== undefined && i === failAfter) throw new Error("page failed");
          seen.yielded++;
          yield rawMarket(i) as never;
        }
      },
    },
  };
}

describe("fetchAllMarkets", () => {
  test("reads every page, past the old 500-market stop", async () => {
    const { client, seen } = stubClient(1234);
    const r = await fetchAllMarkets(client);
    expect(seen.query).toEqual({ status: ["open"], limit: PAGE_SIZE });
    expect(r.status).toBe(200);
    expect(r.markets).toHaveLength(1234);
    expect(r.markets[1233]?.marketId).toBe("m-1233");
    expect(r.pages).toBe(7);
    expect(r.truncated).toBe(false);
    expect((r.firstPage as { markets: unknown[] }).markets).toHaveLength(PAGE_SIZE);
  });

  test("an empty catalog is one successful page", async () => {
    const r = await fetchAllMarkets(stubClient(0).client);
    expect(r.status).toBe(200);
    expect(r.markets).toEqual([]);
    expect(r.pages).toBe(1);
  });

  test("stops at MAX_MARKETS and flags the result truncated", async () => {
    const { client, seen } = stubClient(MAX_MARKETS + 500);
    const r = await fetchAllMarkets(client);
    expect(r.markets).toHaveLength(MAX_MARKETS);
    expect(r.truncated).toBe(true);
    expect(seen.yielded).toBe(MAX_MARKETS + 1);
  });

  test("a later page failing keeps the markets already read", async () => {
    const r = await fetchAllMarkets(stubClient(1000, 400).client);
    expect(r.status).toBe(502);
    expect(r.markets).toHaveLength(400);
    expect(r.pages).toBe(3);
  });

  test("a first page failing returns the error as the detail", async () => {
    const r = await fetchAllMarkets(stubClient(10, 0).client);
    expect(r.status).toBe(502);
    expect(r.markets).toEqual([]);
    expect(r.firstPage).toEqual({ error: "page failed" });
  });
});

describe("CatalogCache", () => {
  const ok = (n: number): CatalogResult => ({
    status: 200,
    markets: Array.from({ length: n }, (_, i) => ({ marketId: `m-${i}` }) as never),
    pages: 1,
    truncated: false,
  });
  const failed = (n = 0): CatalogResult => ({ ...ok(n), status: 502 });

  // A cache over a scripted list of fetch results and a hand-moved clock.
  function scripted(results: CatalogResult[]) {
    const clock = { t: 0 };
    let calls = 0;
    const cache = new CatalogCache(async () => results[Math.min(calls++, results.length - 1)]!, 60_000, () => clock.t);
    return { cache, clock, calls: () => calls };
  }

  test("serves the cached catalog within the TTL without refetching", async () => {
    const { cache, clock, calls } = scripted([ok(3), ok(5)]);
    const first = await cache.get();
    expect(first.fetched?.markets).toHaveLength(3);
    clock.t = 59_999;
    const second = await cache.get();
    expect(second.result.markets).toHaveLength(3);
    expect(second.fetched).toBeUndefined();
    expect(calls()).toBe(1);
  });

  test("refetches once the TTL has passed", async () => {
    const { cache, clock, calls } = scripted([ok(3), ok(5)]);
    await cache.get();
    clock.t = 60_000;
    const r = await cache.get();
    expect(r.result.markets).toHaveLength(5);
    expect(r.fetched?.markets).toHaveLength(5);
    expect(calls()).toBe(2);
  });

  test("concurrent requests share one fetch, and only the first logs it", async () => {
    let release!: (r: CatalogResult) => void;
    let calls = 0;
    const cache = new CatalogCache(() => {
      calls++;
      return new Promise<CatalogResult>((res) => (release = res));
    });
    const a = cache.get();
    const b = cache.get();
    release(ok(4));
    const [ra, rb] = await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(ra.fetched?.markets).toHaveLength(4);
    expect(rb.fetched).toBeUndefined();
    expect(rb.result.markets).toHaveLength(4);
  });

  test("a failed refetch serves the last good catalog as stale and retries next time", async () => {
    const { cache, clock, calls } = scripted([ok(3), failed(200), ok(6)]);
    await cache.get();
    clock.t = 60_000;
    const stale = await cache.get();
    expect(stale.stale).toBe(true);
    expect(stale.result.markets).toHaveLength(3);
    expect(stale.fetched?.status).toBe(502);
    const retried = await cache.get();
    expect(retried.result.markets).toHaveLength(6);
    expect(retried.stale).toBe(false);
    expect(calls()).toBe(3);
  });

  test("a failed fetch with nothing cached is served as is but not cached", async () => {
    const { cache, calls } = scripted([failed(400), ok(2)]);
    const r = await cache.get();
    expect(r.result.status).toBe(502);
    expect(r.result.markets).toHaveLength(400);
    expect(r.stale).toBe(false);
    expect((await cache.get()).result.markets).toHaveLength(2);
    expect(calls()).toBe(2);
  });
});
