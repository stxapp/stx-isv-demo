// Persistence behind thin interfaces.
//
// Every store is defined as an interface first, then implemented over SQLite.
// The rest of the backend depends only on the interfaces, so a production port
// can swap in a Postgres/Redis implementation without touching the OAuth logic.

import { db } from "./db";
import { serializeDetail, type ActivityDetail } from "./activityDetail";

// ---- User store (the mock ISV-app user + their own wallet) -----------------

// A mock user of an ISV app (e.g. a Sideline customer), scoped to one browser
// session and one app profile. `walletCents` is the app's OWN balance: the
// ISV-held money, entirely separate from any STX balance.
export interface User {
  id: string;
  sessionId: string;
  appId: string;
  name: string;
  walletCents: number;
  createdAt: number;
  // The user's id in the app's own login (Privy), or null for the mock sign-in.
  externalId: string | null;
}

export interface UserStore {
  // Create the user for (session, app) if absent, else return the existing one.
  // `name` and `startingWalletCents` are used only on first creation.
  ensure(args: {
    sessionId: string;
    appId: string;
    name: string;
    startingWalletCents: number;
  }): User;
  get(userId: string): User | null;
  find(sessionId: string, appId: string): User | null;
  // Sign in a user of the app's own login (externalId: the Privy user id) on
  // this browser session. A returning user gets their existing row (wallet and
  // STX link), moved to this session; a first sign-in adopts this session's
  // mock user if there is one, else creates the user.
  signInExternal(args: {
    sessionId: string;
    appId: string;
    externalId: string;
    name: string;
    startingWalletCents: number;
  }): User;
  // Detach the user from this browser session without deleting them, so the
  // next sign-in (any browser) finds their wallet and STX link again.
  detachSession(sessionId: string, appId: string): void;
  // Remove the user for (session, app). The caller removes any link first.
  remove(sessionId: string, appId: string): void;
  // Add demo funds to the user's own wallet; returns the updated user.
  addFunds(userId: string, cents: number): User | null;
}

// ---- Account-link store (STX grant linked to an ISV user) ------------------

// The STX grant linked to an ISV user. Tokens live only here.
export interface AccountLink {
  userId: string;
  appId: string;
  accessToken: string;
  refreshToken: string | null;
  // epoch ms when the access token expires, or null if the server did not say.
  accessExpiresAt: number | null;
  scopes: string[];
  linkedAt: number;
}

export interface LinkStore {
  // Upsert the link for a user, preserving the original linkedAt on update.
  save(link: Omit<AccountLink, "linkedAt"> & { linkedAt?: number }): void;
  get(userId: string): AccountLink | null;
  delete(userId: string): void;
}

// ---- Activity store --------------------------------------------------------

export interface ActivityRecord {
  id: number;
  ts: number;
  appId: string | null;
  method: string;
  path: string;
  status: number | null;
  note: string | null;
  // The @stxapp/stx-typescript call that produced the row, as code (see sdkCall.ts).
  // Null on rows written before the column existed.
  sdkCall: string | null;
  // Whether a request/response detail is stored for the row (see detail()).
  hasDetail: boolean;
}

// What a caller hands to record(): the row, plus the optional detail and the
// ISV user the call was made for. The detail is redacted and size-capped here,
// whatever the caller passed.
export type ActivityEntry = Omit<ActivityRecord, "id" | "sdkCall" | "hasDetail"> & {
  sdkCall?: string | null;
  detail?: ActivityDetail | null;
  userId?: string | null;
};

export interface ActivityStore {
  record(entry: ActivityEntry): void;
  // List newest-first, optionally filtered to one app. Details are not listed.
  list(limit: number, appId?: string): ActivityRecord[];
  // The stored detail of one row, and who it belongs to (null: app-level).
  detail(id: number): { appId: string | null; userId: string | null; detail: ActivityDetail | null } | null;
}

// ---- Flow store (transient PKCE + state) -----------------------------------

export interface AuthFlow {
  codeVerifier: string;
  sessionId: string;
  appId: string;
  userId: string;
}

export interface FlowStore {
  save(state: string, flow: AuthFlow): void;
  // Consume the flow: returns it and deletes it so a state can be used once.
  take(state: string): AuthFlow | null;
}

// ---- SQLite implementations ------------------------------------------------

function newId(): string {
  return crypto.randomUUID();
}

export const userStore: UserStore = {
  ensure({ sessionId, appId, name, startingWalletCents }) {
    const existing = this.find(sessionId, appId);
    if (existing) return existing;

    const user: User = {
      id: newId(),
      sessionId,
      appId,
      name,
      walletCents: startingWalletCents,
      createdAt: Date.now(),
      externalId: null,
    };
    db.query(
      `INSERT INTO users (id, session_id, app_id, name, wallet_cents, created_at)
       VALUES ($id, $sid, $app, $name, $wallet, $now)`,
    ).run({
      $id: user.id,
      $sid: user.sessionId,
      $app: user.appId,
      $name: user.name,
      $wallet: user.walletCents,
      $now: user.createdAt,
    });
    return user;
  },

  get(userId) {
    const row = db
      .query(`SELECT * FROM users WHERE id = $id`)
      .get({ $id: userId }) as UserRow | null;
    return row ? rowToUser(row) : null;
  },

  find(sessionId, appId) {
    const row = db
      .query(`SELECT * FROM users WHERE session_id = $sid AND app_id = $app`)
      .get({ $sid: sessionId, $app: appId }) as UserRow | null;
    return row ? rowToUser(row) : null;
  },

  signInExternal({ sessionId, appId, externalId, name, startingWalletCents }) {
    const returning = db
      .query(`SELECT * FROM users WHERE app_id = $app AND external_id = $ext`)
      .get({ $app: appId, $ext: externalId }) as UserRow | null;
    const here = this.find(sessionId, appId);
    if (returning) {
      if (here && here.id !== returning.id) {
        // This browser held another user (a mock one, or someone else signed in
        // before): it leaves the session; a mock user with no login is dropped.
        if (here.externalId) this.detachSession(sessionId, appId);
        else {
          linkStore.delete(here.id);
          this.remove(sessionId, appId);
        }
      }
      db.query(`UPDATE users SET session_id = $sid WHERE id = $id`).run({ $sid: sessionId, $id: returning.id });
      return this.get(returning.id) as User;
    }
    if (here && !here.externalId) {
      db.query(`UPDATE users SET external_id = $ext, name = $name WHERE id = $id`).run({
        $ext: externalId,
        $name: name,
        $id: here.id,
      });
      return this.get(here.id) as User;
    }
    if (here) this.detachSession(sessionId, appId);
    const user = this.ensure({ sessionId, appId, name, startingWalletCents });
    db.query(`UPDATE users SET external_id = $ext WHERE id = $id`).run({ $ext: externalId, $id: user.id });
    return this.get(user.id) as User;
  },

  detachSession(sessionId, appId) {
    // A detached user keeps a unique placeholder session, so (session, app)
    // stays unique and no browser holds them until they sign in again.
    db.query(`UPDATE users SET session_id = 'detached:' || id WHERE session_id = $sid AND app_id = $app`).run({
      $sid: sessionId,
      $app: appId,
    });
  },

  remove(sessionId, appId) {
    db.query(`DELETE FROM users WHERE session_id = $sid AND app_id = $app`).run({
      $sid: sessionId,
      $app: appId,
    });
  },

  addFunds(userId, cents) {
    db.query(`UPDATE users SET wallet_cents = wallet_cents + $cents WHERE id = $id`).run({
      $id: userId,
      $cents: cents,
    });
    return this.get(userId);
  },
};

interface UserRow {
  id: string;
  session_id: string;
  app_id: string;
  name: string;
  wallet_cents: number;
  created_at: number;
  external_id: string | null;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    sessionId: row.session_id,
    appId: row.app_id,
    name: row.name,
    walletCents: row.wallet_cents,
    createdAt: row.created_at,
    externalId: row.external_id ?? null,
  };
}

export const linkStore: LinkStore = {
  save(link) {
    const now = Date.now();
    db.query(
      `INSERT INTO account_links
         (user_id, app_id, access_token, refresh_token, access_expires_at, scopes, linked_at, updated_at)
       VALUES ($uid, $app, $access, $refresh, $exp, $scopes, $linked, $now)
       ON CONFLICT(user_id) DO UPDATE SET
         app_id = $app,
         access_token = $access,
         refresh_token = $refresh,
         access_expires_at = $exp,
         scopes = $scopes,
         updated_at = $now`,
    ).run({
      $uid: link.userId,
      $app: link.appId,
      $access: link.accessToken,
      $refresh: link.refreshToken,
      $exp: link.accessExpiresAt,
      $scopes: link.scopes.join(" "),
      // Preserve the original linkedAt on update; set it on first insert.
      $linked: link.linkedAt ?? now,
      $now: now,
    });
  },

  get(userId) {
    const row = db
      .query(
        `SELECT user_id, app_id, access_token, refresh_token, access_expires_at, scopes, linked_at
         FROM account_links WHERE user_id = $uid`,
      )
      .get({ $uid: userId }) as
      | {
          user_id: string;
          app_id: string;
          access_token: string;
          refresh_token: string | null;
          access_expires_at: number | null;
          scopes: string | null;
          linked_at: number;
        }
      | null;

    if (!row) return null;
    return {
      userId: row.user_id,
      appId: row.app_id,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      accessExpiresAt: row.access_expires_at,
      scopes: row.scopes ? row.scopes.split(" ").filter(Boolean) : [],
      linkedAt: row.linked_at,
    };
  },

  delete(userId) {
    db.query(`DELETE FROM account_links WHERE user_id = $uid`).run({ $uid: userId });
  },
};

export const activityStore: ActivityStore = {
  record(entry) {
    db.query(
      `INSERT INTO activity (ts, app_id, method, path, status, note, sdk_call, detail, user_id)
       VALUES ($ts, $app, $method, $path, $status, $note, $sdk, $detail, $uid)`,
    ).run({
      $ts: entry.ts,
      $app: entry.appId,
      $method: entry.method,
      $path: entry.path,
      $status: entry.status,
      $note: entry.note,
      $sdk: entry.sdkCall ?? null,
      $detail: serializeDetail(entry.detail),
      $uid: entry.userId ?? null,
    });
  },

  list(limit, appId) {
    const cols = `id, ts, app_id AS appId, method, path, status, note, sdk_call AS sdkCall,
                  (detail IS NOT NULL) AS hasDetail`;
    const rows = appId
      ? db
          .query(`SELECT ${cols} FROM activity WHERE app_id = $app ORDER BY id DESC LIMIT $limit`)
          .all({ $app: appId, $limit: limit })
      : db.query(`SELECT ${cols} FROM activity ORDER BY id DESC LIMIT $limit`).all({ $limit: limit });
    return (rows as (Omit<ActivityRecord, "hasDetail"> & { hasDetail: number })[]).map((r) => ({
      ...r,
      hasDetail: r.hasDetail === 1,
    }));
  },

  detail(id) {
    const row = db
      .query(`SELECT app_id AS appId, user_id AS userId, detail FROM activity WHERE id = $id`)
      .get({ $id: id }) as { appId: string | null; userId: string | null; detail: string | null } | null;
    if (!row) return null;
    let detail: ActivityDetail | null = null;
    try {
      detail = row.detail ? (JSON.parse(row.detail) as ActivityDetail) : null;
    } catch {
      detail = null;
    }
    return { appId: row.appId, userId: row.userId, detail };
  },
};

export const flowStore: FlowStore = {
  save(state, flow) {
    db.query(
      `INSERT OR REPLACE INTO auth_flows (state, code_verifier, session_id, app_id, user_id, created_at)
       VALUES ($state, $verifier, $sid, $app, $uid, $now)`,
    ).run({
      $state: state,
      $verifier: flow.codeVerifier,
      $sid: flow.sessionId,
      $app: flow.appId,
      $uid: flow.userId,
      $now: Date.now(),
    });
  },

  take(state) {
    const row = db
      .query(
        `SELECT code_verifier, session_id, app_id, user_id FROM auth_flows WHERE state = $state`,
      )
      .get({ $state: state }) as
      | { code_verifier: string; session_id: string; app_id: string; user_id: string }
      | null;

    if (!row) return null;
    db.query(`DELETE FROM auth_flows WHERE state = $state`).run({ $state: state });
    return {
      codeVerifier: row.code_verifier,
      sessionId: row.session_id,
      appId: row.app_id,
      userId: row.user_id,
    };
  },
};
