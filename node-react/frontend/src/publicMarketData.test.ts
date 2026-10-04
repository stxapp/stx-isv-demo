import { describe, expect, test } from "bun:test";
import { setStxUrl, stxHost } from "./publicMarketData";

describe("stxHost", () => {
  test("names the STX environment the backend points at", () => {
    setStxUrl("https://stx-sandbox.example.com/");
    expect(stxHost()).toBe("stx-sandbox.example.com");
  });

  test("keeps a non-default port", () => {
    expect(stxHost("http://localhost:4000")).toBe("localhost:4000");
  });

  test("falls back to the raw value when it is not a URL", () => {
    expect(stxHost("not a url")).toBe("not a url");
  });
});
