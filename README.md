# STX ISV Integration Demo - "Heater"

A reference showing how a third-party partner app - an **ISV** - integrates with
the STX exchange over **OAuth 2.0**. The demo app is **Heater**, a mock
fantasy/sports app that:

1. has its **own users and its own wallet** (Heater-held credits), like the real
   ISV model where the front-end app holds a balance of its own;
2. lets a signed-in Heater user **link their STX account** (the OAuth connect
   flow), storing the STX grant against the Heater user;
3. shows a **dual wallet** - the Heater wallet next to the real **STX balance**,
   with a combined total - making clear which funds live where (STX funds stay
   at STX); and
4. browses **public STX market data** live, with no credential.

STX is the exchange; Heater is a front-end / ISV that never holds STX funds and
never sees an STX token in the browser. It is a teaching example: clarity over
polish, real code over hand-waving.

The reference stack is a **Bun/TypeScript** backend (the confidential OAuth
client) plus a **Vite/React** frontend, wired together with Docker Compose. The
OAuth logic is deliberately isolated so a port to Next.js, Python, or Go is
obvious. The full integration guide, including the authorization flow, scopes,
tokens, and hosted pages, is at [docs.stxapp.io/isv](https://docs.stxapp.io/isv).

## Quickstart

```bash
cd node-react
cp .env.example .env      # fill in CLIENT_ID, CLIENT_SECRET, STX_BASE_URL
docker compose up         # backend :8787, frontend :5173
```

Open <http://localhost:5173>:

1. **Sign in to Heater** (a mock login - no password; creates your Heater user
   and credits your Heater wallet).
2. Click **Link your STX account** - this runs the OAuth authorization-code +
   PKCE flow: Heater redirects you to STX to authenticate and consent, then
   exchanges the code for tokens **server-side**.
3. Back in Heater, your **dual wallet** shows Heater credits + your STX balance +
   the combined total, and you can place/track/cancel orders as the linked
   member.

Running without Docker:

```bash
# backend
cd node-react/backend && bun install && bun run dev
# frontend (new shell)
cd node-react/frontend && bun install && bun run dev
```

## Running against a live STX

The demo talks to an STX environment set by `STX_BASE_URL`. What works depends on
what you configure:

- **Public market data** needs `STX_BASE_URL` plus `CLIENT_ID` and
  `CLIENT_SECRET`: the backend mints an app token (`client_credentials`, scope
  `market_data`) and uses it for the market catalog and the live feeds. No
  member has to be linked to browse markets.
- **Linking an STX account and trading** uses the same OAuth client, whose
  registered redirect URI matches `REDIRECT_URI` (`http://localhost:8787/callback`
  by default). The link flow sends the member to STX's hosted login and consent,
  so the STX host must expose the authorization endpoint. Contact STX to get a
  client and a reachable base URL.

The client secret is only ever read from env on the server and sent to the token
endpoint over HTTP Basic; it is never exposed to the browser.

## The integration model

- **Heater has its own wallet.** The Heater wallet is the demo's own balance,
  held in the demo's store (SQLite). It is entirely separate from any STX
  balance. Seeded per app via `APP_WALLET_CENTS`.
- **Account linking.** A Heater user is created on mock sign-in. Linking runs
  OAuth and stores the STX access/refresh tokens **against that Heater user**
  (not against a bare session), so the link persists across reconnection. The
  browser only ever holds an opaque session cookie.
- **Dual wallet.** `Heater Wallet` (authoritative, held here) + `STX Wallet`
  (fetched live from STX via the link, scope `balance.read`) + `Combined`. The
  combined total is shown only when the STX cash amount can be parsed from STX's
  balance response; otherwise the raw STX response is shown and no total is
  invented. STX funds are always labelled as held at STX.
- **Scoped, money-safe.** Heater requests only the scopes it needs from STX's
  vocabulary (`profile.read balance.read portfolio.read orders.read transfers.read orders.write terms.write`;
  the demo defaults to `profile.read balance.read portfolio.read orders.read orders.write`). STX narrows
  them to what the member consents to. **No scope moves money** - `transfers.read` is
  read-only history; deposits/withdrawals are never delegable.
- **Unlink / revoke.** Unlinking clears the local grant and best-effort revokes
  the token at STX, so access ends immediately rather than at token expiry. The
  Heater user + wallet remain, so they can relink.

## Architecture

![STX ISV demo architecture: browser, ISV backend (confidential OAuth client), STX exchange](docs/architecture.svg)

- **Backend** (`node-react/backend`, Bun + Hono): holds the app's
  `client_secret` and every STX token, brokers the OAuth link flow, tracks the
  app's mock wallet, proxies authenticated STX calls, and keeps an
  activity log. Persistence is **SQLite** behind swappable store interfaces
  (`src/stores.ts`).
- **Frontend** (`node-react/frontend`, Vite + React): the Heater member journey
  (sign in → dual wallet → link STX → trade) plus a live market-data panel fed
  by the backend over SSE, which holds the app token; the browser opens no STX
  socket and holds no credential.

### Store schema (`backend/src/stores.ts` over `backend/src/db.ts`)

| Table           | Keyed by            | What it holds |
| --------------- | ------------------- | ------------- |
| `users`         | `(session_id, app_id)` unique | the mock ISV user + their own `wallet_cents` (the Heater wallet). One per browser session. |
| `account_links` | `user_id`           | the STX grant linked to a user: access/refresh tokens, granted scopes, `linked_at`. The only place STX tokens live. |
| `auth_flows`    | `state` (one-time)  | transient PKCE verifier + which `app_id`/`user_id` the resulting grant links to. |
| `activity`      | autoincrement       | every STX request, tagged with `app_id`, for the activity panel. |

### Backend routes

| Route | Purpose |
| ----- | ------- |
| `GET /api/apps` | the ISV app profile this demo presents as (no secrets) |
| `GET /api/me?app=` | the app + signed-in user (+ wallet) + link status |
| `POST /api/login?app=` | mock ISV sign-in (creates user + wallet) |
| `POST /api/signout?app=` | sign out of the app (revoke + drop link, remove user) |
| `POST /api/unlink?app=` | unlink STX (revoke + drop grant), keep the user + wallet |
| `GET /api/wallet?app=` | dual wallet: Heater wallet + STX balance + combined |
| `GET /api/balance?app=` | raw STX balance proxy |
| `GET /POST /api/orders?app=`, `DELETE /api/orders/:id?app=` | order proxies |
| `GET /api/activity?app=` | the STX request log |
| `GET /login?app=`, `GET /callback` | the OAuth account-linking flow |

## What the demo exercises

This backend is wired to STX's **real** OAuth contract, not a generic one:
`client_secret_basic` at the token endpoint, opaque `stx_at_`/`stx_rt_` tokens,
the `profile.read balance.read portfolio.read orders.read transfers.read orders.write terms.write` scope
vocabulary, and the real REST paths and order body.

End to end it covers:

- The **authorization-code + PKCE** link flow: authorize, consent, callback,
  server-side code exchange, refresh, and revoke.
- **Scoped REST** with the member's `Authorization: Bearer stx_at_...`:
  `/api/v1/account/balance`, `/api/v1/orders` (GET/POST), `/api/v1/orders/batched`
  (POST), `/api/v1/orders/:id` (DELETE), `/api/v1/fills` and
  `/api/v1/portfolio/settlements`, with per-request scope enforcement.
- The member's **live portfolio feed** (orders, fills, balances) over the STX
  WebSocket, authenticated with the same bearer.
- **App tokens** (`grant_type=client_credentials`, scope `market_data`) for the
  public **market catalog** (`GET /api/v1/markets`) and the public
  **market-data WebSocket** (`ticker`/`trades`/`orderbook`/`market_stats`,
  token on the `x-stx-oauth-token` handshake header).

The integration is REST plus WebSockets only. Tokens of both kinds stay on the
backend; the browser talks only to this app and receives live data as
server-sent events.

Everything about the OAuth base URL, endpoint paths, scopes, and the app profile
is env-configurable, so nothing is hard-coded.

## Tests

```bash
cd node-react/backend && bun test        # OAuth contract + store layer
cd node-react/backend && bun run typecheck
cd node-react/frontend && bun run typecheck
```

## Repo layout

```
stx-isv-demo/
  README.md
  docs/architecture.svg       # architecture diagram (see docs.stxapp.io/isv for the flow)
  node-react/
    docker-compose.yml        # backend + frontend (+ commented-out postgres alt)
    .env.example
    backend/                  # Bun + TypeScript - confidential OAuth client, wallets, linking
    frontend/                 # Vite + React - the Heater member journey + public market data
```

## License

MIT. See [LICENSE](./LICENSE).
