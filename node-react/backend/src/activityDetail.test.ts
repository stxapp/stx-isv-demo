// The activity detail: the request and response behind a row, redacted before
// it is stored. Proves that a token, secret, code or key in a request or a
// response never reaches the activity table or the activity API, that details
// are stored and served, and that rows written before details existed still
// list and answer cleanly.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Same env block as oauth.test.ts / stores.test.ts (the config singleton is
// shared across test files in one process).
process.env.STX_BASE_URL = "https://stx.example.com";
process.env.CLIENT_ID = "sideline-test-client-id";
process.env.CLIENT_SECRET = "sideline-test-client-secret";
process.env.REDIRECT_URI = "http://localhost:8787/callback";
process.env.OAUTH_SCOPES = "profile.read balance.read portfolio.read orders.read orders.write";
process.env.DB_PATH = ":memory:";

const { readCallback } = await import("@stxapp/stx-typescript/oauth");
const { config } = await import("./config");
const { db } = await import("./db");
const { activityStore, linkStore, userStore } = await import("./stores");
const { memberClient, pendingStore, stxApp } = await import("./stx");
const { apiRoutes } = await import("./routes/api");
const { BODY_LIMIT, LIST_ITEMS, buildDetail, redact, safeBody, serializeDetail } = await import("./activityDetail");

const sideline = config.app;

const PEM = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f\n-----END PRIVATE KEY-----\n";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtZW1iZXIifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ";

// Every secret any test below feeds in. None may appear in the DB or the API.
const SECRETS = [
  "stx_at_SECRET_ACCESS",
  "stx_rt_SECRET_REFRESH",
  "stx_code_SECRET",
  "sideline-test-client-secret",
  "VERIFIER_SECRET_abcdefghijklmnopqrstuvwxyz0123456789",
  "MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f",
  JWT,
  "hunter2-password",
];

function dbDump(): string {
  return JSON.stringify(db.query("SELECT * FROM activity").all());
}

function expectNoSecrets(text: string): void {
  for (const s of SECRETS) expect(text).not.toContain(s);
}

const realFetch = globalThis.fetch;
function mockFetch(handler: (url: string, init: RequestInit) => Response): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init ?? {})) as typeof fetch;
}
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function signedIn(): { sid: string; uid: string } {
  const sid = `s-${crypto.randomUUID()}`;
  const uid = userStore.ensure({ sessionId: sid, appId: "sideline", name: "A", startingWalletCents: 1 }).id;
  return { sid, uid };
}

function link(uid: string): void {
  linkStore.save({
    userId: uid,
    appId: "sideline",
    accessToken: "stx_at_SECRET_ACCESS",
    refreshToken: "stx_rt_SECRET_REFRESH",
    accessExpiresAt: Date.now() + 3_600_000,
    scopes: ["balance.read", "orders.read", "orders.write"],
  });
}

async function getJson(path: string, sid?: string): Promise<{ status: number; text: string; body: any }> {
  const res = await apiRoutes.request(path, { headers: sid ? { cookie: `isv_sid=${sid}` } : {} });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
}

beforeEach(() => {
  db.exec("DELETE FROM users; DELETE FROM account_links; DELETE FROM auth_flows; DELETE FROM activity;");
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("redact", () => {
  test("replaces secret keys at any depth and secret-shaped values under any key", () => {
    const out = redact({
      access_token: "stx_at_SECRET_ACCESS",
      nested: { refresh_token: "stx_rt_SECRET_REFRESH", client_secret: "sideline-test-client-secret", keep: "ok" },
      code: "stx_code_SECRET",
      code_verifier: "VERIFIER_SECRET_abcdefghijklmnopqrstuvwxyz0123456789",
      id_token: JWT,
      Authorization: "Bearer stx_at_SECRET_ACCESS",
      "x-stx-oauth-token": "stx_at_SECRET_ACCESS",
      password: "hunter2-password",
      note: `pasted key ${PEM} and a jwt ${JWT}`,
      list: [{ private_key: PEM }],
      price: "0.01",
    });
    expectNoSecrets(JSON.stringify(out));
    expect(out).toMatchObject({ price: "0.01", nested: { keep: "ok" } });
  });

  test("client IP fields are redacted", () => {
    const out = redact({
      order: { id: "o-1", ip_address: "10.11.124.170" },
      remote_ip: "203.0.113.9",
      x_forwarded_for: "203.0.113.9, 10.0.0.1",
      "X-Forwarded-For": "198.51.100.7",
      client_ip: "198.51.100.8",
    });
    const text = JSON.stringify(out);
    for (const ip of ["10.11.124.170", "203.0.113.9", "198.51.100.7", "198.51.100.8"]) expect(text).not.toContain(ip);
    expect(out).toMatchObject({ order: { id: "o-1", ip_address: "[redacted]" } });
  });

  test("keeps the first items of a long list and says how many there were", () => {
    const out = redact({ orders: Array.from({ length: 25 }, (_, i) => ({ id: i })) }) as { orders: unknown[] };
    expect(out.orders.length).toBe(LIST_ITEMS + 1);
    expect(out.orders[LIST_ITEMS]).toBe(`… ${25 - LIST_ITEMS} more (25 items in total)`);
  });

  test("a body over the limit is cut, flagged, and its size kept", () => {
    const big = JSON.stringify({ blob: "x".repeat(BODY_LIMIT * 2) });
    const d = safeBody(big);
    expect(d.truncated).toBe(true);
    expect((d.body as string).length).toBe(BODY_LIMIT);
    expect(d.size).toBe(big.length);
  });

  test("a form body and a query string are parsed and redacted", () => {
    const d = buildDetail({
      method: "POST",
      path: "/oauth/token?code=stx_code_SECRET&x=1",
      requestBody: "grant_type=authorization_code&code=stx_code_SECRET&code_verifier=VERIFIER_SECRET_abcdefghijklmnopqrstuvwxyz0123456789",
      status: 200,
      responseBody: JSON.stringify({ access_token: "stx_at_SECRET_ACCESS", token_type: "bearer", expires_in: 3600 }),
    });
    expectNoSecrets(JSON.stringify(d));
    expect(d.request?.query).toEqual({ code: "[redacted]", x: "1" });
    expect(d.request?.body).toMatchObject({ grant_type: "authorization_code" });
    expect(d.response?.body).toMatchObject({ token_type: "bearer", expires_in: 3600 });
  });

  test("serializeDetail is a last guard even for a detail built by hand", () => {
    const text = serializeDetail({ note: `Bearer stx_at_SECRET_ACCESS ${PEM}` })!;
    expectNoSecrets(text);
  });
});

describe("token endpoint rows", () => {
  test("a code exchange stores its detail with the code, verifier, secret and tokens redacted", async () => {
    mockFetch(() =>
      json(200, {
        access_token: "stx_at_SECRET_ACCESS",
        refresh_token: "stx_rt_SECRET_REFRESH",
        id_token: JWT,
        token_type: "bearer",
        expires_in: 3600,
        scope: "balance.read orders.write",
      }),
    );
    const { sid, uid } = signedIn();
    const { oauth, tokens } = stxApp(sideline);
    const auth = await oauth.beginAuthorization(pendingStore, { data: { sessionId: sid, appId: "sideline", userId: uid } });
    const cb = await readCallback(pendingStore, { code: "stx_code_SECRET", state: auth.state });
    await oauth.redeemAuthorization(cb, { store: tokens, memberKey: uid });
    // The tokens themselves are stored, where they belong.
    expect(linkStore.get(uid)!.accessToken).toBe("stx_at_SECRET_ACCESS");

    SECRETS.push(auth.codeVerifier);
    expectNoSecrets(dbDump());

    const [row] = activityStore.list(10, "sideline");
    expect(row!.note).toBe("Linked STX account");
    expect(row!.hasDetail).toBe(true);
    const list = await getJson("/activity?app=sideline", sid);
    expectNoSecrets(list.text);
    const detail = await getJson(`/activity/${row!.id}/detail`, sid);
    expect(detail.status).toBe(200);
    expectNoSecrets(detail.text);
    expect(detail.body.detail.request.body).toMatchObject({ grant_type: "authorization_code", code: "[redacted]" });
    expect(detail.body.detail.response.body).toMatchObject({ access_token: "[redacted]", token_type: "bearer" });
    SECRETS.pop();
  });
});

describe("member REST rows", () => {
  test("an order row stores the request body and the response; the bearer token is never stored", async () => {
    const { sid, uid } = signedIn();
    link(uid);
    mockFetch((url, init) => {
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer stx_at_SECRET_ACCESS");
      if (url.endsWith("/api/v1/orders") && init.method === "POST") {
        return json(201, { order: { id: "o-1", market_id: "m-1", price: "0.01", status: "open" } });
      }
      return json(404, {});
    });
    await memberClient(sideline, uid, "Placed an order", "stx.placeOrder(...)").placeOrder("m-1", "buy", "limit", {
      price: "0.01",
      quantity: "1",
    });
    expectNoSecrets(dbDump());

    const [row] = activityStore.list(10, "sideline");
    const detail = await getJson(`/activity/${row!.id}/detail`, sid);
    expect(detail.body.detail.request).toMatchObject({ method: "POST", path: "/api/v1/orders" });
    expect(detail.body.detail.request.body).toMatchObject({ market_id: "m-1", price: "0.01" });
    expect(detail.body.detail.response).toMatchObject({ status: 201, body: { order: { id: "o-1" } } });
  });

  test("a secret echoed in a response body is redacted before it is stored", async () => {
    const { sid, uid } = signedIn();
    link(uid);
    mockFetch(() =>
      json(200, {
        balance: { available_balance: "12.00" },
        debug: { access_token: "stx_at_SECRET_ACCESS", echo: "Bearer stx_at_SECRET_ACCESS", key: PEM },
      }),
    );
    await memberClient(sideline, uid, "Checked STX balance").balance();
    expectNoSecrets(dbDump());
    const [row] = activityStore.list(10, "sideline");
    const detail = await getJson(`/activity/${row!.id}/detail`, sid);
    expectNoSecrets(detail.text);
    expect(detail.body.detail.response.body.balance).toEqual({ available_balance: "12.00" });
  });

  test("a member's detail is not served to another session", async () => {
    const { uid } = signedIn();
    link(uid);
    mockFetch(() => json(200, { balance: { available_balance: "12.00" } }));
    await memberClient(sideline, uid, "Checked STX balance").balance();
    const [row] = activityStore.list(10, "sideline");
    const other = signedIn();
    expect((await getJson(`/activity/${row!.id}/detail`, other.sid)).status).toBe(404);
    expect((await getJson(`/activity/${row!.id}/detail`)).status).toBe(404);
  });
});

describe("rows without a detail", () => {
  test("a row written before the detail column existed lists and answers a null detail", async () => {
    db.query(
      `INSERT INTO activity (ts, app_id, method, path, status, note, sdk_call) VALUES (1, 'sideline', 'GET', '/api/v1/orders', 200, 'Loaded order history', NULL)`,
    ).run();
    const list = await getJson("/activity?app=sideline");
    expect(list.status).toBe(200);
    expect(list.body.activity[0]).toMatchObject({ path: "/api/v1/orders", hasDetail: false, sdkCall: null });
    const detail = await getJson(`/activity/${list.body.activity[0].id}/detail`);
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual({ detail: null });
  });

  test("an unknown id is a 404", async () => {
    expect((await getJson("/activity/999999/detail")).status).toBe(404);
  });
});
