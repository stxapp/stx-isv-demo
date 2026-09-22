// The authenticated STX client used by the proxy routes.
//
// Responsibilities:
//   - attach the linked member's access token as `Authorization: Bearer`
//   - on a 401, refresh once (rotating the stored pair) and retry
//   - log every STX request to the activity store, tagged with the app
//
// The browser talks only to this backend; it never holds a token. Calls operate
// on an `AccountLink` (the STX grant linked to an ISV user) and the `AppProfile`
// that owns the OAuth client used to refresh it.

import { config, type AppProfile } from "./config";
import { expiryFrom, refreshTokens } from "./oauth";
import { activityStore, linkStore, type AccountLink } from "./stores";

export interface StxResult {
  status: number;
  body: unknown;
}

// Records one STX interaction for GET /api/activity, tagged with the app.
function logActivity(
  appId: string,
  method: string,
  path: string,
  status: number | null,
  note?: string,
): void {
  activityStore.record({ ts: Date.now(), appId, method, path, status, note: note ?? null });
}

async function doFetch(
  method: string,
  path: string,
  accessToken: string,
  body?: unknown,
): Promise<Response> {
  const url = config.stxBaseUrl + path;
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// Refresh the link's tokens and persist the rotated pair. Returns the new link,
// or null if refresh is impossible (no refresh token) or rejected (e.g. the
// grant was revoked on STX).
async function tryRefresh(app: AppProfile, link: AccountLink): Promise<AccountLink | null> {
  if (!link.refreshToken) return null;
  try {
    const refreshed = await refreshTokens(app, link.refreshToken);
    const updated: AccountLink = {
      userId: link.userId,
      appId: link.appId,
      accessToken: refreshed.access_token,
      // STX rotates refresh tokens; keep the new one, fall back to the old.
      refreshToken: refreshed.refresh_token ?? link.refreshToken,
      accessExpiresAt: expiryFrom(refreshed),
      scopes: refreshed.scope ? refreshed.scope.split(" ").filter(Boolean) : link.scopes,
      linkedAt: link.linkedAt,
    };
    linkStore.save(updated);
    logActivity(app.id, "POST", config.paths.token, 200, "refreshed access token");
    return updated;
  } catch (err) {
    logActivity(app.id, "POST", config.paths.token, 401, `refresh failed: ${String(err)}`);
    return null;
  }
}

// Perform an authenticated STX call for a linked ISV user, refreshing once on a
// 401. `app` owns the OAuth client (for refresh + activity tagging); `link`
// holds the tokens.
export async function stxRequest(
  app: AppProfile,
  link: AccountLink,
  method: string,
  path: string,
  body?: unknown,
  label?: string,
): Promise<StxResult> {
  let current = link;
  let res = await doFetch(method, path, current.accessToken, body);

  // Refresh-and-retry exactly once on an expired/invalid access token.
  if (res.status === 401) {
    const refreshed = await tryRefresh(app, current);
    if (refreshed) {
      current = refreshed;
      res = await doFetch(method, path, current.accessToken, body);
    }
  }

  const text = await res.text();
  const parsed = safeJson(text);
  logActivity(app.id, method, path, res.status, label);
  return { status: res.status, body: parsed };
}

function safeJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Thrown when the caller has no signed-in user, or that user has not linked an
// STX account yet. Routes turn it into a clean 401.
export class NotLinkedError extends Error {
  constructor(message = "No linked STX account — sign in and link first.") {
    super(message);
    this.name = "NotLinkedError";
  }
}
