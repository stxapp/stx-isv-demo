# Where each step lives in the code

This page maps each step of working with a member's STX account to the file in this repo that does it and the [`@stxapp/stx-typescript`](https://docs.stxapp.io/sdks/typescript/) call it uses. It does not explain the steps themselves. The STX docs do, and they are the source of truth:

- [OAuth overview](https://docs.stxapp.io/oauth/): how an app works with a member's STX account
- [Authorization code flow](https://docs.stxapp.io/oauth/authorization-flow/): the redirect, consent, callback and code exchange
- [Scopes](https://docs.stxapp.io/oauth/scopes/): what an app can ask for. No scope moves money
- [Tokens and security](https://docs.stxapp.io/oauth/tokens-and-security/): lifetimes, refresh, rotation, revocation
- [Discovery and errors](https://docs.stxapp.io/oauth/discovery-and-errors/): published configuration and the errors an app sees
- [Environments](https://docs.stxapp.io/environments/): the hosts to use

All paths below are under `node-react/backend/src/`.

## Who does what in this app

- **The browser** holds only the app's own session cookie, never an STX token.
- **The backend** keeps the client secret and every STX token, and makes every call to STX.
- **STX** hosts its own login, sign-up and consent pages, and the API.

The app's STX client is one `OAuthClient`, built once in [`stx.ts`](../node-react/backend/src/stx.ts). The SDK keeps its state through two small stores the app implements over SQLite, also in `stx.ts`: `FlowPendingStore` (the PKCE verifier and state between the redirect and the callback) and `LinkTokenStore` (each member's tokens, keyed by the app's own user id).

## Link an STX account (login modes `own` and `vendor`)

| Step | Route | Code | SDK call |
| --- | --- | --- | --- |
| Send the member to STX | `GET /login` | [`login/link.ts`](../node-react/backend/src/login/link.ts) | `oauth.beginAuthorization(pendingStore, { data, connection, loginHint })` |
| Check what came back | `GET /callback` | `login/link.ts` | `readCallback(pendingStore, callbackUrl)` |
| Exchange the code, store the tokens | `GET /callback` | `login/link.ts` | `oauth.redeemAuthorization(callback, { store, memberKey })` |
| Tell the page the result | `GET /callback` | [`login/shared.ts`](../node-react/backend/src/login/shared.ts) `finishLink` | none |

`connection` and `loginHint` are optional hints from the app's own login: go straight to the sign-in method the user used with the app, and preselect their account.

## Register or log in with an STX account (login mode `stx`)

| Step | Route | Code | SDK call |
| --- | --- | --- | --- |
| Send the person to STX | `GET /auth/stx/start` | [`login/stx/index.ts`](../node-react/backend/src/login/stx/index.ts) | `connect.start({ connection, loginHint })` |
| Exchange the code, verify the ID token | `GET /auth/stx/callback` | `login/stx/index.ts` | `connect.finish(callbackUrl, saved)` |
| Find or create the app's user | `GET /auth/stx/callback` | `login/stx/index.ts`, [`login/shared.ts`](../node-react/backend/src/login/shared.ts) `identityKey` | none: keyed on `identity.sub` and the exchange it came from |
| Store the tokens | `GET /auth/stx/callback` | `login/stx/index.ts` | `LinkTokenStore.set` |

`connect` is `createConnect({ issuer, clientId, clientSecret, redirectUri, scopes })`. What is kept between the two requests (state, PKCE verifier, nonce, and the browser session that started it) is in the `signin_flows` table ([`stores.ts`](../node-react/backend/src/stores.ts)).

## A login service that offers STX (login mode `vendor`)

| Step | Route | Code | Library |
| --- | --- | --- | --- |
| Send the person to the login service | `GET /auth/vendor/start` | [`login/vendor/index.ts`](../node-react/backend/src/login/vendor/index.ts) | `openid-client` |
| Verify the service's ID token, sign them in | `GET /auth/vendor/callback` | `login/vendor/index.ts` | `openid-client` |
| Link their STX account | `GET /login`, `GET /callback` | `login/link.ts`, as above | the STX SDK |

## Acting for the member

| What | Route | Code | SDK call |
| --- | --- | --- | --- |
| A client that sends the member's token and refreshes it | all below | [`stx.ts`](../node-react/backend/src/stx.ts) `memberClient` | `oauth.memberClient(tokens, memberKey)` |
| Balance | `GET /api/balance`, `GET /api/wallet` | [`routes/api.ts`](../node-react/backend/src/routes/api.ts) | `stx.balance()` |
| Orders | `GET`/`POST /api/orders`, `POST /api/orders/batch`, `DELETE /api/orders/:id` | `routes/api.ts` | `stx.orders()`, `stx.placeOrder()`, `stx.placeOrders()`, `stx.cancelOrder()` |
| Fills and settlements | `GET /api/trades`, `GET /api/settlements` | `routes/api.ts` | `stx.fills()`, `stx.settlements()` |
| Live account data | `GET /api/stream` | [`liveProxy.ts`](../node-react/backend/src/liveProxy.ts) | `stx.websocket()`, `ws.accountView({ onChange })` |
| Unlink | `POST /api/unlink` | `routes/api.ts` `revokeAndDropLink` | `oauth.unlink(tokens, memberKey)` |

What the app does with the SDK's errors:

| Error | What the app does | Code |
| --- | --- | --- |
| `STXGrantRevokedException`: the member's grant is gone | shows "not linked", so they can link again | `routes/api.ts` `forward` |
| `STXAccountPendingException`: STX is still verifying the member | answers `409 account_pending` and keeps the link; on a callback, shows a message and leaves them as they were | `routes/api.ts` `forward`, `login/stx/index.ts` |
| `access_denied` on a callback: they cancelled at STX | says so, and lets them try again | `login/stx/index.ts`, `login/link.ts` |
| any other `STXException` | forwards STX's status and body to the browser | `routes/api.ts` `forward` |

## Market data on the app's own token

| What | Route | Code | SDK call |
| --- | --- | --- | --- |
| The app's own client (no member) | none | [`stx.ts`](../node-react/backend/src/stx.ts) `stxApp().catalog` | `oauth.appClient("market_data")` |
| The market catalog | `GET /api/markets`, `GET /api/markets/:id/trades` | [`marketCatalog.ts`](../node-react/backend/src/marketCatalog.ts) | `catalog.markets()`, `catalog.market()` |
| Prices, books, trades, live scores | `GET /api/market-stream` | [`marketProxy.ts`](../node-react/backend/src/marketProxy.ts) | `catalog.websocket()`, then `ws.ticker()`, `ws.orderbook()`, `ws.trades()`, `ws.marketStats()`, `ws.market()` |

## See every call as it happens

The running app's **API calls** page lists each request the backend made to STX, with the SDK call behind it and a redacted request and response ([`sdkCall.ts`](../node-react/backend/src/sdkCall.ts), [`activityDetail.ts`](../node-react/backend/src/activityDetail.ts)).
