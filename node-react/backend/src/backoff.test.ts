import { describe, expect, test } from "bun:test";
import { BASE_DELAY_MS, MAX_DELAY_MS, backoffDelayMs } from "./backoff";

describe("backoffDelayMs", () => {
  test("doubles per attempt at the jitter midpoint", () => {
    const mid = () => 0.5; // jitter factor 1.0
    expect(backoffDelayMs(0, mid)).toBe(BASE_DELAY_MS);
    expect(backoffDelayMs(1, mid)).toBe(2 * BASE_DELAY_MS);
    expect(backoffDelayMs(3, mid)).toBe(8 * BASE_DELAY_MS);
  });

  test("never exceeds the cap, even with maximum jitter", () => {
    const high = () => 1; // jitter factor 1.5
    expect(backoffDelayMs(10, high)).toBe(MAX_DELAY_MS);
    expect(backoffDelayMs(1000, high)).toBe(MAX_DELAY_MS);
  });

  test("jitter spreads a delay over 50-150% of nominal", () => {
    expect(backoffDelayMs(2, () => 0)).toBe(2000);
    expect(backoffDelayMs(2, () => 1)).toBe(6000);
  });

  test("a negative attempt behaves like the first retry", () => {
    expect(backoffDelayMs(-5, () => 0.5)).toBe(BASE_DELAY_MS);
  });
});
