// Unit tests for the store layer that models the Heater/ISV integration:
//   - the ISV user + their own wallet (per browser session)
//   - the STX account link (tokens keyed by user)
//   - the transient auth flow (carries the user; single-use)
//   - the activity log
// plus the best-effort STX cash extraction that powers the combined wallet.
//
// Runs against an in-memory SQLite so nothing touches disk. `config` reads env
// at import time, so the required vars (and DB_PATH=:memory:) are set first.

import { beforeEach, describe, expect, test } from "bun:test";

// The `config` singleton is built once per test process and shared across test
// files, so this env block is identical to the one in oauth.test.ts — whichever
// file loads config first, both see the same profile and an in-memory DB.
process.env.STX_BASE_URL = "https://stx.example.com";
process.env.CLIENT_ID = "stx_client_HEATER";
process.env.CLIENT_SECRET = "stx_secret_HEATER";
process.env.REDIRECT_URI = "http://localhost:8787/callback";
process.env.OAUTH_SCOPES = "profile.read balance.read portfolio.read orders.read orders.write";
process.env.DB_PATH = ":memory:";

const { db } = await import("./db");
const { userStore, linkStore, flowStore, activityStore } = await import("./stores");
const { extractStxCashCents, centsToDollarString } = await import("./helpers");

// A fresh slate before each test — the in-memory DB is shared within this file.
beforeEach(() => {
  db.exec("DELETE FROM users; DELETE FROM account_links; DELETE FROM auth_flows; DELETE FROM activity;");
});

describe("userStore — the ISV user + their own wallet", () => {
  test("ensure creates a user with the seeded wallet, then is idempotent", () => {
    const a = userStore.ensure({
      sessionId: "sess-1",
      appId: "heater",
      name: "Ada",
      startingWalletCents: 25_000,
    });
    expect(a.name).toBe("Ada");
    expect(a.walletCents).toBe(25_000);

    // Second call for the same session returns the SAME user, and does not
    // reseed the wallet or rename.
    const again = userStore.ensure({
      sessionId: "sess-1",
      appId: "heater",
      name: "Someone Else",
      startingWalletCents: 999,
    });
    expect(again.id).toBe(a.id);
    expect(again.name).toBe("Ada");
    expect(again.walletCents).toBe(25_000);
  });

  test("two browser sessions get two distinct users + wallets", () => {
    const first = userStore.ensure({
      sessionId: "sess-1",
      appId: "heater",
      name: "Ada",
      startingWalletCents: 25_000,
    });
    const second = userStore.ensure({
      sessionId: "sess-2",
      appId: "heater",
      name: "Grace",
      startingWalletCents: 25_000,
    });
    expect(second.id).not.toBe(first.id);
    expect(userStore.find("sess-1", "heater")?.id).toBe(first.id);
    expect(userStore.find("sess-2", "heater")?.id).toBe(second.id);
  });

  test("remove drops the user for a session, leaving others intact", () => {
    userStore.ensure({ sessionId: "s1", appId: "heater", name: "A", startingWalletCents: 1 });
    userStore.ensure({ sessionId: "s2", appId: "heater", name: "B", startingWalletCents: 1 });
    userStore.remove("s1", "heater");
    expect(userStore.find("s1", "heater")).toBeNull();
    expect(userStore.find("s2", "heater")).not.toBeNull();
  });
});

describe("linkStore — the STX grant linked to a user", () => {
  function seedUser(sessionId = "s"): string {
    return userStore.ensure({ sessionId, appId: "heater", name: "A", startingWalletCents: 1 }).id;
  }

  test("save then get round-trips the tokens and scopes", () => {
    const uid = seedUser();
    linkStore.save({
      userId: uid,
      appId: "heater",
      accessToken: "stx_at_1",
      refreshToken: "stx_rt_1",
      accessExpiresAt: 123,
      scopes: ["profile.read", "balance.read", "orders.write"],
    });
    const link = linkStore.get(uid);
    expect(link?.accessToken).toBe("stx_at_1");
    expect(link?.refreshToken).toBe("stx_rt_1");
    expect(link?.scopes).toEqual(["profile.read", "balance.read", "orders.write"]);
    expect(link?.linkedAt).toBeGreaterThan(0);
  });

  test("save preserves the original linkedAt across a token rotation", () => {
    const uid = seedUser();
    linkStore.save({
      userId: uid,
      appId: "heater",
      accessToken: "stx_at_1",
      refreshToken: "stx_rt_1",
      accessExpiresAt: null,
      scopes: ["orders.write"],
    });
    const first = linkStore.get(uid)!;
    // Rotate: new access/refresh, no linkedAt passed.
    linkStore.save({
      userId: uid,
      appId: "heater",
      accessToken: "stx_at_2",
      refreshToken: "stx_rt_2",
      accessExpiresAt: 999,
      scopes: ["orders.write"],
    });
    const rotated = linkStore.get(uid)!;
    expect(rotated.accessToken).toBe("stx_at_2");
    expect(rotated.refreshToken).toBe("stx_rt_2");
    expect(rotated.linkedAt).toBe(first.linkedAt);
  });

  test("delete removes the grant so a later get returns null", () => {
    const uid = seedUser();
    linkStore.save({
      userId: uid,
      appId: "heater",
      accessToken: "stx_at_1",
      refreshToken: null,
      accessExpiresAt: null,
      scopes: ["orders.write"],
    });
    linkStore.delete(uid);
    expect(linkStore.get(uid)).toBeNull();
  });
});

describe("flowStore — transient PKCE + state", () => {
  test("take returns the flow with app + user, then it is single-use", () => {
    flowStore.save("state-abc", {
      codeVerifier: "verifier",
      sessionId: "sess-1",
      appId: "heater",
      userId: "user-9",
    });
    const flow = flowStore.take("state-abc");
    expect(flow).toEqual({
      codeVerifier: "verifier",
      sessionId: "sess-1",
      appId: "heater",
      userId: "user-9",
    });
    // Consumed — a replay of the same state finds nothing.
    expect(flowStore.take("state-abc")).toBeNull();
  });
});

describe("activityStore — request log", () => {
  test("list returns newest-first and can filter by app", () => {
    activityStore.record({ ts: 1, appId: "heater", method: "GET", path: "/a", status: 200, note: null });
    activityStore.record({ ts: 2, appId: "heater", method: "GET", path: "/b", status: 200, note: null });
    activityStore.record({ ts: 3, appId: "heater", method: "POST", path: "/c", status: 201, note: null });

    expect(activityStore.list(100, "heater").map((r) => r.path)).toEqual(["/c", "/b", "/a"]);
    expect(activityStore.list(100).length).toBe(3);
    expect(activityStore.list(100, "nope").length).toBe(0);
  });
});

describe("extractStxCashCents — best-effort, dollar-strings only", () => {
  test("parses a recognised cash key given as a dollar string", () => {
    expect(extractStxCashCents({ cash: "1234.56" })).toBe(123456);
    expect(extractStxCashCents({ available_balance: "$1,000.00" })).toBe(100000);
  });

  test("sees through a nested envelope", () => {
    expect(extractStxCashCents({ data: { balance: { available: "50.00" } } })).toBe(5000);
  });

  test("never guesses units from a bare number, and returns null when unknown", () => {
    // A number is ambiguous (cents vs dollars) — not parsed, so no fake total.
    expect(extractStxCashCents({ cash: 1234 })).toBeNull();
    expect(extractStxCashCents({ unrelated: "5.00" })).toBeNull();
    expect(extractStxCashCents(null)).toBeNull();
    expect(extractStxCashCents("nope")).toBeNull();
  });

  test("centsToDollarString formats cents as a plain dollar string", () => {
    expect(centsToDollarString(25_000)).toBe("250.00");
    expect(centsToDollarString(5)).toBe("0.05");
  });
});
