# OAuth 2.0 flow (stack-agnostic)

This describes the authorization-code + PKCE flow the demo implements, without
reference to Bun, React, or any framework: so a Next.js, Python, or Go port is a
matter of re-expressing these same steps.

## Roles

- **Member (resource owner)**: the STX user whose account is being accessed.
- **ISV app (client)**: the partner application (here, Sideline, a fictional
  sports app used to demonstrate building on STX; not a real product or
  company). It is a *confidential* client: it has a `client_secret` and a
  server-side component that keeps tokens away from the browser. Another partner
  app would be a **separate OAuth client** with its own `client_id`/`secret`, and
  the same member linking from it would get an independent grant.
- **STX (authorization + resource server)**: issues codes and tokens at
  `/oauth/*`, and serves the API at `/api/v1/*` and the public market-data
  WebSocket at `/socket`.

## This is account LINKING

In the demo the member is already a signed-in ISV-app user (a Sideline customer
with their own wallet). "Connecting" is **linking their STX account to that
existing ISV user**: the flow below runs on a user action, and the resulting
grant is stored against the ISV user, not against a bare session. So one ISV
user has at most one STX link.

## Credentials, issued at registration

When the ISV app is registered with STX it receives:

- `client_id`: public identifier.
- `client_secret`: confidential; only the backend ever holds it.
- one or more **redirect URIs**: STX **exact-matches** the `redirect_uri` at both
  `/authorize` and `/token`; there is no prefix or wildcard matching.
- **allowed scopes**: the upper bound on what the app may ever request.

## The flow

```
 Member        ISV backend (confidential client)            STX
   |                  |                                       |
   | click Connect    |                                       |
   |----------------->| 1. make PKCE verifier + challenge     |
   |                  |    make state                         |
   |                  |    store {state -> verifier, session} |
   |   302 to STX     |                                       |
   |<-----------------|                                       |
   |  2. /oauth/authorize?response_type=code&client_id=...&redirect_uri=...
   |     &scope=...&code_challenge=...&code_challenge_method=S256&state=...
   |-------------------------------------------------------->|
   |                  |         3. authenticate + consent     |
   |   302 back to redirect_uri?code=...&state=...            |
   |<--------------------------------------------------------|
   | 4. /callback?code&state                                 |
   |----------------->| verify state (single-use)            |
   |                  | 5. POST /oauth/token                  |
   |                  |    grant_type=authorization_code      |
   |                  |    code, redirect_uri, code_verifier  |
   |                  |    Authorization: Basic base64(id:secret)
   |                  |-------------------------------------->|
   |                  |    { access_token, refresh_token,     |
   |                  |      expires_in, scope }              |
   |                  |<--------------------------------------|
   |                  | 6. store tokens server-side,          |
   |                  |    keyed by local session cookie      |
   |   302 to app     |                                       |
   |<-----------------|                                       |
```

### 1. PKCE (RFC 7636)

Before redirecting, the client generates:

- `code_verifier`: a high-entropy random string (32 random bytes, base64url).
- `code_challenge` = base64url(SHA-256(`code_verifier`)).
- `code_challenge_method` = `S256`. **`plain` is not used**: it offers no
  protection if the authorize request is intercepted, and STX rejects it.

The verifier is kept server-side (never sent in step 2) and presented only at the
token exchange (step 5). This proves the party redeeming the code is the same
party that started the flow, so a code intercepted in the redirect is useless on
its own.

### 2. Authorize request

The browser is redirected to `/oauth/authorize` with `response_type=code`,
`client_id`, the exact `redirect_uri`, the space-delimited `scope`, the
`code_challenge` (+ method), and an opaque **`state`**. `state` is a single-use,
unguessable value tying the callback back to this specific login attempt; it
defeats CSRF and cross-session code injection.

### 3. Authenticate + consent

STX authenticates the member and shows a consent screen naming the app and the
scopes. STX narrows the requested scopes to the intersection of the client's
allowed scopes and what the member approves. **No scope moves money**: deposits,
withdrawals, and transfers are never delegable to an ISV.

### 4–5. Callback + token exchange

STX redirects to `redirect_uri?code=...&state=...`. The client:

1. verifies `state` matches a flow it started, and consumes it (single-use);
2. POSTs to `/oauth/token` with `grant_type=authorization_code`, the `code`, the
   same `redirect_uri`, and the `code_verifier`, authenticating itself with
   **`client_secret_basic`** (`Authorization: Basic base64(client_id:secret)`).

STX returns `access_token`, `refresh_token`, `expires_in`, and `scope`.

### 6. Token storage

Tokens are stored **server-side**, keyed to a local session cookie. The browser
holds only that opaque session id: never a token. All calls to STX are made by
the backend, attaching `Authorization: Bearer <access_token>`.

## Refresh

Access tokens are short-lived. When STX returns **401**, the client uses the
refresh token once:

```
POST /oauth/token
grant_type=refresh_token
refresh_token=<current>
Authorization: Basic base64(client_id:secret)
```

STX **rotates** the refresh token: the response carries a new refresh token and
the old one is invalidated. The client must persist the new pair and retry the
original request once. Presenting an already-rotated refresh token is treated as
theft and revokes the whole grant, so never keep the old one.

## Revoke

Unlinking the STX account should end access immediately, not at token expiry.
The client:

1. best-effort calls `/oauth/revoke` (RFC 7009) with the token, using **that
   app's** `client_secret_basic`, and
2. deletes the local grant (the ISV user + wallet remain, so they can relink).

Because STX tokens are server-referenced (not self-validating JWTs), revocation
takes effect on the very next call. An operator can also revoke a partner's grant
centrally, which invalidates every token issued under it at once.

## Public market data: an app token, no member

Market data needs no member. The backend mints its own **app token** with the
`client_credentials` grant (scope `market_data`, `client_secret_basic`), reads
the catalog over REST (`GET /api/v1/markets`) and joins the public market
channels (`ticker`, `orderbook`, `trades`, `market_stats`, `market:<id>`) on a
socket authenticated with that token. It relays what it receives to the browser
over Server-Sent Events. The browser opens no STX socket and holds no token.

## Endpoint summary

| Purpose            | Method          | Path (default)                            | Auth                        |
| ------------------ | --------------- | ----------------------------------------- | --------------------------- |
| Metadata (RFC 8414)| GET             | `/.well-known/oauth-authorization-server` | none                        |
| Authorize          | GET             | `/oauth/authorize`                        | member session on STX       |
| Token / refresh    | POST            | `/oauth/token`                            | `client_secret_basic`       |
| Revoke             | POST            | `/oauth/revoke`                           | `client_secret_basic`       |
| Identity           | GET             | `/api/v1/me`                              | `Bearer` (scope `profile.read`) |
| Balance            | GET             | `/api/v1/account/balance`                 | `Bearer` (scope `balance.read`)  |
| List orders        | GET             | `/api/v1/orders`                          | `Bearer` (scope `orders.read`)  |
| Place order        | POST            | `/api/v1/orders`                          | `Bearer` (scope `orders.write`)    |
| Cancel order       | DELETE          | `/api/v1/orders/:id`                      | `Bearer` (scope `orders.write`)    |
| App token          | POST            | `/oauth/token` (`client_credentials`)     | `client_secret_basic`       |
| Public market data | GET, WS         | `/api/v1/markets`, `/socket` channels     | `Bearer` app token (scope `market_data`) |
| Member live feed   | WS              | `/socket` → `balances:`/`orders:`/`fills:`/`positions:` | `x-stx-oauth-token` header |

All paths are configurable via environment variables; the defaults above match
STX today.

## Scope vocabulary

STX's fixed scope set is `profile.read balance.read portfolio.read orders.read
transfers.read orders.write terms.write`. Each is a coarse capability bundle, not one
endpoint. `orders.write` is the only write scope over the order book;
`transfers.read` is **read-only** deposit /
withdrawal history: **no scope moves money**. Scope is space-delimited on the
wire, and STX enforces it per request on REST requests and channel joins. The
demo defaults to `profile.read balance.read portfolio.read orders.read orders.write`.

## Placing an order

`POST /api/v1/orders` takes a JSON body with these fields,
**not** a generic `{market_id, side, price, quantity}`:

- `market_id`: required.
- `order_type`: required, `"limit"` | `"market"`.
- `action`: required, `"buy"` | `"sell"` (this is the field named `action`, not
  `side`).
- `price`: a dollar **string**, e.g. `"40.00"`; required for `limit`, omitted
  for `market`. A JSON number is rejected `400` (it would be misread as subunits).
- `quantity`: a decimal **string**, e.g. `"100"`. A JSON number is rejected `400`.

## OAuth over the WebSocket

STX authenticates a socket with an access token in the `x-stx-oauth-token`
header on the WebSocket handshake. A browser cannot set WebSocket headers (and
must never hold the token anyway), so the backend opens the socket: one per
linked member for the account topics (`balances:<uid>`, `orders:<uid>`,
`fills:<uid>`, `positions:<uid>`, each gated by its scope), and one per market
subscription on the app token. Both are relayed to the browser over SSE.
