// Small shared helpers for the routes: resolving the active app profile from a
// request, and best-effort extraction of a cash amount from STX's balance body.

import type { Context } from "hono";
import { getApp, type AppProfile } from "./config";

// The active ISV app for a request. The frontend appends `?app=<id>` to every
// call; absent or unknown falls back to the default app. Returns null only for
// an explicitly-supplied unknown id, so routes can 400.
export function appFromRequest(c: Context): AppProfile | null {
  const id = c.req.query("app");
  if (id === undefined) return getApp(null); // default
  return getApp(id);
}

// ---- Best-effort STX cash extraction ---------------------------------------
//
// STX returns money on the wire as DOLLAR STRINGS (e.g. "1234.56"), never as an
// ambiguous number, so this parses string values only and never guesses units
// from a bare number. It walks the balance body (up to a shallow depth, to see
// through a `{ data: … }` / `{ balance: … }` envelope) and returns the first
// recognised cash field as cents, or null when it cannot parse one confidently.
// The demo shows a combined total only when this succeeds; otherwise it shows
// the raw STX balance and leaves the total out rather than inventing a number.

const CASH_KEYS = new Set([
  "available_balance",
  "available",
  "cash_balance",
  "cash",
  "balance",
  "buying_power",
  "total_balance",
  "total",
  "amount",
]);

function dollarStringToCents(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}

export function extractStxCashCents(body: unknown, depth = 2): number | null {
  if (body == null || typeof body !== "object" || depth < 0) return null;
  const obj = body as Record<string, unknown>;

  // Prefer a recognised cash key with a parseable dollar-string value.
  for (const [key, value] of Object.entries(obj)) {
    if (CASH_KEYS.has(key.toLowerCase())) {
      const cents = dollarStringToCents(value);
      if (cents !== null) return cents;
    }
  }
  // Otherwise descend through envelope objects (data / balance / account / …).
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      const cents = extractStxCashCents(value, depth - 1);
      if (cents !== null) return cents;
    }
  }
  return null;
}

// Format cents as a plain dollar string, e.g. 25000 -> "250.00".
export function centsToDollarString(cents: number): string {
  return (cents / 100).toFixed(2);
}
