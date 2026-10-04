import { describe, expect, test } from "bun:test";
import { gaDomainsFrom, gaMeasurementIdFrom, gaRegionsFrom } from "./analytics";

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

describe("gaDomainsFrom", () => {
  test("unset or empty is an empty list", () => {
    expect(gaDomainsFrom(undefined)).toEqual([]);
    expect(gaDomainsFrom(null)).toEqual([]);
    expect(gaDomainsFrom("")).toEqual([]);
    expect(gaDomainsFrom(" , ,")).toEqual([]);
  });
  test("comma-separated hosts are trimmed, lower-cased and de-duplicated", () => {
    expect(gaDomainsFrom(" Example.com, docs.example.com ,example.com,.other.org")).toEqual([
      "example.com",
      "docs.example.com",
      "other.org",
    ]);
  });
  test("entries that are not host names are dropped", () => {
    expect(gaDomainsFrom("https://example.com,example.com/path,localhost,ex ample.com,ok.io")).toEqual(["ok.io"]);
  });
});

describe("gaRegionsFrom", () => {
  test("unset or empty is an empty list", () => {
    expect(gaRegionsFrom(undefined)).toEqual([]);
    expect(gaRegionsFrom(null)).toEqual([]);
    expect(gaRegionsFrom("")).toEqual([]);
    expect(gaRegionsFrom(" , ")).toEqual([]);
  });
  test("country and subdivision codes are kept, trimmed and upper-cased", () => {
    expect(gaRegionsFrom("GB, ca-qc ,DE,GB")).toEqual(["GB", "CA-QC", "DE"]);
  });
  test("anything else is dropped", () => {
    expect(gaRegionsFrom("GBR,G,CA_QC,EU-,FR")).toEqual(["FR"]);
  });
});
