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

const { toTradeRows } = await import("./marketCatalog");

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
