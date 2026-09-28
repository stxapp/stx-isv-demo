import { describe, expect, test } from "bun:test";
import { gaMeasurementIdFrom } from "./analytics";

describe("gaMeasurementIdFrom", () => {
  test("unset or empty is off", () => {
    expect(gaMeasurementIdFrom(undefined)).toBeNull();
    expect(gaMeasurementIdFrom(null)).toBeNull();
    expect(gaMeasurementIdFrom("")).toBeNull();
    expect(gaMeasurementIdFrom("   ")).toBeNull();
  });
  test("a GA4 id is kept, trimmed and upper-cased", () => {
    expect(gaMeasurementIdFrom("G-ABC123XYZ9")).toBe("G-ABC123XYZ9");
    expect(gaMeasurementIdFrom("  g-abc123xyz9 ")).toBe("G-ABC123XYZ9");
  });
  test("anything else is treated as unset", () => {
    expect(gaMeasurementIdFrom("UA-12345-1")).toBeNull();
    expect(gaMeasurementIdFrom("G-ABC&x=1")).toBeNull();
    expect(gaMeasurementIdFrom("G-<script>")).toBeNull();
    expect(gaMeasurementIdFrom("GTM-ABCDEF")).toBeNull();
  });
});
