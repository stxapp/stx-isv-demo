// A stand-in for STX (or for a login service), for tests and the end-to-end
// run in CI. It is a real HTTP server on a local port that speaks the same
// protocol the app uses against the exchange:
//
//   - the published sign-in configuration and signing keys,
//   - /oauth/authorize, /oauth/token (code + PKCE, refresh with rotation, app
//     tokens), /oauth/revoke and /oauth/userinfo,
//   - the handful of REST endpoints the app's pages call.
//
// What is NOT real here: the person. A real /oauth/authorize shows STX's login
// and consent pages in the member's browser. This mock skips them and answers
// at once as `member`, as if they had logged in and allowed the app (or, with
// `deny`, as if they had cancelled). Everything the app does around that step
// (PKCE, state, nonce, the code exchange, ID token checks, token storage) runs
// for real against it.

import { createHash, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export interface MockClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
}

export interface MockMember {
  sub: string;
  email: string;
  name?: string;
}

export interface MockRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  form: URLSearchParams;
  authorization: string;
}

export interface MockStx {
  /** The server's origin, e.g. http://127.0.0.1:53021. */
  url: string;
  /** Who "logs in" at the next /oauth/authorize. */
  member: MockMember;
  /** The next /oauth/authorize answers `error=access_denied`. */
  deny: boolean;
  /**
   * The member's STX account is still being verified: authorize answers
   * `account_pending`, their access tokens stop working, and a refresh is
   * refused with `invalid_grant` and `error_reason: "account_pending"`.
   */
  pending: boolean;
  /** Overrides the nonce in the next ID token (to test the nonce check). */
  forceNonce: string | null;
  /** Every request received, oldest first. */
  requests: MockRequest[];
  /** Orders placed through the API, by id. */
  orders: Map<string, Record<string, unknown>>;
  stop(): void;
}

interface Grant {
  clientId: string;
  member: MockMember;
  scope: string;
}

const MARKET_ID = "42b861f8-8340-4046-ae06-83a0cec93456";

export async function startMockStx(opts: { clients: MockClient[]; member?: MockMember }): Promise<MockStx> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "mock-1", alg: "RS256", use: "sig" };

  const codes = new Map<string, Grant & { challenge: string; redirectUri: string; nonce: string | null }>();
  const accessTokens = new Map<string, Grant>();
  const refreshTokens = new Map<string, Grant>();
  const appTokens = new Map<string, string>();

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  // The client a token request is from: HTTP Basic with the id and secret as
  // they are (how STX reads them), or the same two as form fields.
  function clientOf(req: MockRequest): MockClient | null {
    let id = req.form.get("client_id") ?? "";
    let secret = req.form.get("client_secret") ?? "";
    if (req.authorization.startsWith("Basic ")) {
      const decoded = Buffer.from(req.authorization.slice(6), "base64").toString();
      const at = decoded.indexOf(":");
      id = decodeURIComponent(decoded.slice(0, at));
      secret = decodeURIComponent(decoded.slice(at + 1));
    }
    return opts.clients.find((c) => c.clientId === id && c.clientSecret === secret) ?? null;
  }

  function issue(grant: Grant) {
    const access = `mock_at_${randomUUID()}`;
    const refresh = `mock_rt_${randomUUID()}`;
    accessTokens.set(access, grant);
    refreshTokens.set(refresh, grant);
    return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 900, scope: grant.scope };
  }

  async function idToken(grant: Grant, nonce: string | null) {
    return new SignJWT({
      ...(nonce ? { nonce } : {}),
      email: grant.member.email,
      email_verified: true,
      ...(grant.member.name ? { name: grant.member.name } : {}),
    })
      .setProtectedHeader({ alg: "RS256", kid: "mock-1" })
      .setIssuer(mock.url)
      .setAudience(grant.clientId)
      .setSubject(grant.member.sub)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  // The grant behind a member bearer token carrying `scope`, or an error response.
  function member(req: MockRequest, scope: string): Grant | Response {
    const grant = accessTokens.get(req.authorization.replace(/^Bearer /, ""));
    if (!grant || mock.pending) return json(401, { error: "invalid_token" });
    if (!grant.scope.split(" ").includes(scope)) return json(403, { error: "insufficient_scope", scope });
    return grant;
  }

  const order = (id: string, body: Record<string, unknown>, status: string) => ({
    id,
    market_id: body.market_id ?? MARKET_ID,
    action: body.action ?? "buy",
    order_type: body.order_type ?? "limit",
    price: body.price ?? "0.0100",
    quantity: body.quantity ?? "1.00",
    filled: "0.00",
    status,
    time: new Date().toISOString(),
  });

  async function handle(req: MockRequest, raw: string): Promise<Response> {
    const { path, query, form } = req;

    if (path === "/.well-known/openid-configuration" || path === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: mock.url,
        authorization_endpoint: `${mock.url}/oauth/authorize`,
        token_endpoint: `${mock.url}/oauth/token`,
        revocation_endpoint: `${mock.url}/oauth/revoke`,
        userinfo_endpoint: `${mock.url}/oauth/userinfo`,
        jwks_uri: `${mock.url}/.well-known/jwks.json`,
        end_session_endpoint: `${mock.url}/logout`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (path === "/.well-known/jwks.json") return json(200, { keys: [jwk] });

    // The mocked step: no login page, no consent page. Answers as `mock.member`.
    if (path === "/oauth/authorize") {
      const client = opts.clients.find((c) => c.clientId === query.get("client_id"));
      const redirectUri = query.get("redirect_uri") ?? "";
      // As at STX: an unknown client or redirect URI is shown to the person,
      // never redirected to.
      if (!client || !client.redirectUris.includes(redirectUri)) return json(400, { error: "invalid_request" });
      const back = new URL(redirectUri);
      if (query.get("state")) back.searchParams.set("state", query.get("state")!);
      const fail = (error: string) => {
        back.searchParams.set("error", error);
        return Response.redirect(back.href, 302);
      };
      if (query.get("response_type") !== "code") return fail("unsupported_response_type");
      if (query.get("code_challenge_method") !== "S256" || !query.get("code_challenge")) return fail("invalid_request");
      if (mock.deny) {
        mock.deny = false;
        return fail("access_denied");
      }
      if (mock.pending) return fail("account_pending");
      const code = `mock_code_${randomUUID()}`;
      codes.set(code, {
        clientId: client.clientId,
        member: mock.member,
        scope: query.get("scope") ?? "",
        challenge: query.get("code_challenge")!,
        redirectUri,
        nonce: mock.forceNonce ?? query.get("nonce"),
      });
      mock.forceNonce = null;
      back.searchParams.set("code", code);
      return Response.redirect(back.href, 302);
    }

    if (path === "/oauth/token" && req.method === "POST") {
      const client = clientOf(req);
      if (!client) return json(401, { error: "invalid_client" });
      const grantType = form.get("grant_type");

      if (grantType === "client_credentials") {
        const token = `mock_app_${randomUUID()}`;
        appTokens.set(token, form.get("scope") ?? "");
        return json(200, { access_token: token, token_type: "Bearer", expires_in: 3600, scope: form.get("scope") ?? "" });
      }

      if (grantType === "authorization_code") {
        const code = codes.get(form.get("code") ?? "");
        // Single use.
        codes.delete(form.get("code") ?? "");
        if (!code || code.clientId !== client.clientId || code.redirectUri !== form.get("redirect_uri")) {
          return json(400, { error: "invalid_grant" });
        }
        // PKCE: the verifier must hash to the challenge sent to /authorize.
        const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (challenge !== code.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE" });
        const grant: Grant = { clientId: code.clientId, member: code.member, scope: code.scope };
        const tokens: Record<string, unknown> = issue(grant);
        if (grant.scope.split(" ").includes("openid")) tokens.id_token = await idToken(grant, code.nonce);
        return json(200, tokens);
      }

      if (grantType === "refresh_token") {
        const old = form.get("refresh_token") ?? "";
        // Still being verified: refused, and the refresh token stays good.
        if (mock.pending && refreshTokens.has(old)) {
          return json(400, { error: "invalid_grant", error_reason: "account_pending" });
        }
        const grant = refreshTokens.get(old);
        // Rotation: a refresh token works once.
        refreshTokens.delete(old);
        if (!grant || grant.clientId !== client.clientId) return json(400, { error: "invalid_grant" });
        return json(200, issue(grant));
      }
      return json(400, { error: "unsupported_grant_type" });
    }

    if (path === "/oauth/revoke" && req.method === "POST") {
      if (!clientOf(req)) return json(401, { error: "invalid_client" });
      const token = form.get("token") ?? "";
      const grant = refreshTokens.get(token) ?? accessTokens.get(token);
      // Revoking a refresh token ends the whole connection.
      if (grant) {
        for (const [k, g] of accessTokens) if (g === grant) accessTokens.delete(k);
        for (const [k, g] of refreshTokens) if (g === grant) refreshTokens.delete(k);
      }
      return new Response("", { status: 200 });
    }

    if (path === "/oauth/userinfo") {
      const grant = member(req, "openid");
      if (grant instanceof Response) return grant;
      return json(200, { sub: grant.member.sub, email: grant.member.email, email_verified: true });
    }

    if (path === "/logout") return new Response("signed out", { status: 200 });

    // ---- REST: what the app's pages read and write -------------------------

    if (path === "/api/v1/account/balance") {
      const grant = member(req, "balance.read");
      if (grant instanceof Response) return grant;
      return json(200, { balance: { account_balance: "154.7500", available_balance: "91.3000", user_id: grant.member.sub } });
    }
    if (path === "/api/v1/me") {
      const grant = member(req, "profile.read");
      if (grant instanceof Response) return grant;
      return json(200, { me: { user_id: grant.member.sub, account_id: grant.member.sub, method: "oauth" } });
    }
    if (path === "/api/v1/orders" && req.method === "GET") {
      const grant = member(req, "orders.read");
      if (grant instanceof Response) return grant;
      return json(200, { orders: [...mock.orders.values()], cursor: null });
    }
    if (path === "/api/v1/orders" && req.method === "POST") {
      const grant = member(req, "orders.write");
      if (grant instanceof Response) return grant;
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      if (!body.quantity) return json(422, { error: "Invalid order fields: quantity - can't be blank" });
      const id = randomUUID();
      mock.orders.set(id, order(id, body, "accepted"));
      return json(200, { order: mock.orders.get(id) });
    }
    if (path === "/api/v1/orders/batched" && req.method === "POST") {
      const grant = member(req, "orders.write");
      if (grant instanceof Response) return grant;
      const body = JSON.parse(raw || "{}") as { orders?: Record<string, unknown>[] };
      const results = (body.orders ?? []).map((o) => {
        const id = randomUUID();
        mock.orders.set(id, order(id, o, "accepted"));
        return { order: mock.orders.get(id) };
      });
      return json(200, { results });
    }
    if (path.startsWith("/api/v1/orders/") && req.method === "DELETE") {
      const grant = member(req, "orders.write");
      if (grant instanceof Response) return grant;
      const id = path.slice("/api/v1/orders/".length);
      const existing = mock.orders.get(id);
      if (!existing) return json(404, { error: "order_not_found" });
      existing.status = "cancelled";
      return json(200, { order_id: id, status: "cancelled" });
    }
    if (path === "/api/v1/fills") {
      const grant = member(req, "orders.read");
      if (grant instanceof Response) return grant;
      return json(200, { fills: [], cursor: null });
    }
    if (path === "/api/v1/portfolio/settlements") {
      const grant = member(req, "portfolio.read");
      if (grant instanceof Response) return grant;
      return json(200, { settlements: [], cursor: null });
    }
    if (path === "/api/v1/markets" || path.startsWith("/api/v1/markets/")) {
      const scope = appTokens.get(req.authorization.replace(/^Bearer /, ""));
      if (scope === undefined) return json(401, { error: "invalid_token" });
      if (!scope.split(" ").includes("market_data")) return json(403, { error: "insufficient_scope" });
      const market = {
        market_id: MARKET_ID,
        event_id: "6d4cdb0b-23b2-47e6-850f-5a2fce17fde9",
        title: "Mock market",
        status: "open",
        bids: [],
        offers: [],
        recent_trades: [],
      };
      return path === "/api/v1/markets" ? json(200, { markets: [market], cursor: null }) : json(200, { market });
    }

    return json(404, { error: "not_found", path });
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const raw = request.method === "GET" ? "" : await request.text();
      const isForm = (request.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded");
      const req: MockRequest = {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        form: new URLSearchParams(isForm ? raw : ""),
        authorization: request.headers.get("authorization") ?? "",
      };
      mock.requests.push(req);
      return handle(req, raw);
    },
  });

  const mock: MockStx = {
    url: `http://127.0.0.1:${server.port}`,
    member: opts.member ?? { sub: "member-1", email: "member@example.com" },
    deny: false,
    pending: false,
    forceNonce: null,
    requests: [],
    orders: new Map(),
    stop: () => server.stop(true),
  };
  return mock;
}

// Run standalone (the end-to-end script starts it this way in another process):
//   bun run test-support/mockStx.ts '<json clients>'
if (import.meta.main) {
  const clients = JSON.parse(process.argv[2] ?? "[]") as MockClient[];
  const mock = await startMockStx({ clients });
  console.log(mock.url);
}
