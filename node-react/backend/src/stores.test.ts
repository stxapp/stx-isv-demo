// Unit tests for the store layer that models the Sideline/ISV integration:
//   - the ISV user + their own wallet (per session)
//   - the STX account link (tokens keyed by user)
//   - the transient auth flow (carries app + user; single-use)
//   - the activity log
// plus the best-effort STX cash extraction that powers the combined wallet.
//
// Runs against an in-memory SQLite so nothing touches disk. `config` reads env
// at import time, so the required vars (and DB_PATH=:memory:) are set first.

import { beforeEach, describe, expect, test } from "bun:test";

// The `config` singleton is built once per test process and shared across test
// files, so this env block is identical to the one in oauth.test.ts: whichever
// file loads config first, both see the same profile and an in-memory DB.
process.env.STX_BASE_URL = "https://stx.example.com";
process.env.CLIENT_ID = "sideline-test-client-id";
process.env.CLIENT_SECRET = "sideline-test-client-secret";
process.env.REDIRECT_URI = "http://localhost:8787/callback";
process.env.OAUTH_SCOPES = "profile.read balance.read portfolio.read orders.read orders.write";
process.env.DB_PATH = ":memory:";

const { db, adoptRetiredAppRows } = await import("./db");
const { userStore, linkStore, flowStore, activityStore } = await import("./stores");
const { extractStxCashCents, centsToDollarString } = await import("./helpers");

// A fresh slate before each test: the in-memory DB is shared within this file.
beforeEach(() => {
  db.exec("DELETE FROM users; DELETE FROM account_links; DELETE FROM auth_flows; DELETE FROM activity;");
});

describe("userStore: the ISV user + their own wallet", () => {
  test("addFunds tops up only that user's wallet", () => {
    const a = userStore.ensure({ sessionId: "s-a", appId: "sideline", name: "A", startingWalletCents: 25_000 });
    const b = userStore.ensure({ sessionId: "s-b", appId: "sideline", name: "B", startingWalletCents: 25_000 });
    expect(userStore.addFunds(a.id, 5_000)?.walletCents).toBe(30_000);
    expect(userStore.get(b.id)?.walletCents).toBe(25_000);
    expect(userStore.addFunds("no-such-user", 100)).toBeNull();
  });

  test("ensure creates a user with the seeded wallet, then is idempotent", () => {
    const a = userStore.ensure({
      sessionId: "sess-1",
      appId: "sideline",
      name: "Ada",
      startingWalletCents: 25_000,
    });
    expect(a.name).toBe("Ada");
    expect(a.walletCents).toBe(25_000);

    // Second call for the same (session, app) returns the SAME user, and does
    // not reseed the wallet or rename.
    const again = userStore.ensure({
      sessionId: "sess-1",
      appId: "sideline",
      name: "Someone Else",
      startingWalletCents: 999,
    });
    expect(again.id).toBe(a.id);
    expect(again.name).toBe("Ada");
    expect(again.walletCents).toBe(25_000);
  });

  test("remove drops the user for one session only", () => {
    userStore.ensure({ sessionId: "s1", appId: "sideline", name: "A", startingWalletCents: 1 });
    userStore.ensure({ sessionId: "s2", appId: "sideline", name: "B", startingWalletCents: 1 });
    userStore.remove("s1", "sideline");
    expect(userStore.find("s1", "sideline")).toBeNull();
    expect(userStore.find("s2", "sideline")).not.toBeNull();
  });
});

describe("linkStore: the STX grant linked to a user", () => {
  function seedUser(appId: string, sessionId = "s"): string {
    return userStore.ensure({ sessionId, appId, name: "A", startingWalletCents: 1 }).id;
  }

  test("save then get round-trips the tokens and scopes", () => {
    const uid = seedUser("sideline");
    linkStore.save({
      userId: uid,
      appId: "sideline",
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
    const uid = seedUser("sideline");
    linkStore.save({
      userId: uid,
      appId: "sideline",
      accessToken: "stx_at_1",
      refreshToken: "stx_rt_1",
      accessExpiresAt: null,
      scopes: ["orders.write"],
    });
    const first = linkStore.get(uid)!;
    // Rotate: new access/refresh, no linkedAt passed.
    linkStore.save({
      userId: uid,
      appId: "sideline",
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

  test("delete drops one user's link and leaves the others", () => {
    const a = seedUser("sideline", "s1");
    const b = seedUser("sideline", "s2");
    for (const [uid, token] of [[a, "stx_at_a"], [b, "stx_at_b"]] as const) {
      linkStore.save({ userId: uid, appId: "sideline", accessToken: token, refreshToken: null, accessExpiresAt: null, scopes: [] });
    }
    linkStore.delete(a);
    expect(linkStore.get(a)).toBeNull();
    expect(linkStore.get(b)?.accessToken).toBe("stx_at_b");
  });
});

describe("flowStore: transient PKCE + state", () => {
  test("take returns the flow with app + user, then it is single-use", () => {
    flowStore.save("state-abc", {
      codeVerifier: "verifier",
      sessionId: "sess-1",
      appId: "sideline",
      userId: "user-9",
    });
    const flow = flowStore.take("state-abc");
    expect(flow).toEqual({
      codeVerifier: "verifier",
      sessionId: "sess-1",
      appId: "sideline",
      userId: "user-9",
    });
    // Consumed: a replay of the same state finds nothing.
    expect(flowStore.take("state-abc")).toBeNull();
  });
});

describe("activityStore: the request log", () => {
  test("list filters by app and returns newest-first", () => {
    activityStore.record({ ts: 1, appId: "sideline", method: "GET", path: "/a", status: 200, note: null });
    activityStore.record({ ts: 2, appId: "oldapp", method: "GET", path: "/b", status: 200, note: null });
    activityStore.record({ ts: 3, appId: "sideline", method: "POST", path: "/c", status: 201, note: null });

    const sidelineOnly = activityStore.list(100, "sideline");
    expect(sidelineOnly.map((r) => r.path)).toEqual(["/c", "/a"]);

    const all = activityStore.list(100);
    expect(all.length).toBe(3);
  });
});

describe("extractStxCashCents: best-effort, dollar-strings only", () => {
  test("parses a recognised cash key given as a dollar string", () => {
    expect(extractStxCashCents({ cash: "1234.56" })).toBe(123456);
    expect(extractStxCashCents({ available_balance: "$1,000.00" })).toBe(100000);
  });

  test("sees through a nested envelope", () => {
    expect(extractStxCashCents({ data: { balance: { available: "50.00" } } })).toBe(5000);
  });

  test("never guesses units from a bare number, and returns null when unknown", () => {
    // A number is ambiguous (cents vs dollars): not parsed, so no fake total.
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

describe("adoptRetiredAppRows: members keep their rows when the app id changes", () => {
  function seedRetired(appId: string, sessionId: string) {
    const user = userStore.ensure({ sessionId, appId, name: "Ada", startingWalletCents: 25_000 });
    linkStore.save({
      userId: user.id,
      appId,
      accessToken: "stx_at_A",
      refreshToken: "stx_rt_A",
      accessExpiresAt: null,
      scopes: ["balance.read"],
    });
    flowStore.save("state-1", { codeVerifier: "v", sessionId, appId, userId: user.id });
    activityStore.record({ ts: 1, appId, method: "GET", path: "/x", status: 200, note: null });
    return user;
  }

  test("every retired id moves to the app, nothing is dropped", () => {
    const user = seedRetired("oldapp", "sess-1");
    expect(adoptRetiredAppRows("sideline")).toEqual({ from: ["oldapp"], to: "sideline" });

    expect(userStore.find("sess-1", "sideline")?.id).toBe(user.id);
    expect(userStore.find("sess-1", "oldapp")).toBeNull();
    const link = linkStore.get(user.id);
    expect(link?.appId).toBe("sideline");
    expect(link?.accessToken).toBe("stx_at_A");
    expect(flowStore.take("state-1")?.appId).toBe("sideline");
    expect(activityStore.list(10, "sideline")).toHaveLength(1);
    // Idempotent: a second boot finds nothing retired.
    expect(adoptRetiredAppRows("sideline")).toEqual({ from: [], to: null });
  });

  test("a session already signed in under the new id keeps both users", () => {
    const old = seedRetired("oldapp", "sess-1");
    const current = userStore.ensure({ sessionId: "sess-1", appId: "sideline", name: "B", startingWalletCents: 1 });
    adoptRetiredAppRows("sideline");
    expect(userStore.find("sess-1", "sideline")?.id).toBe(current.id);
    expect(userStore.get(old.id)?.appId).toBe("oldapp");
    expect(linkStore.get(old.id)?.appId).toBe("oldapp");
  });
});
