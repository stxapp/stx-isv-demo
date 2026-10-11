// SQLite bootstrap.
//
// One database, created on boot if absent. SQLite keeps the demo self-contained
// (no external service to run) while still being a real, persistent store
// mounted on a Docker volume. The stores in stores.ts sit behind interfaces so
// swapping this for Postgres is a drop-in: see the commented-out postgres
// service in docker-compose.yml.
//
// The schema models the Sideline/ISV integration story:
//   users          : a mock ISV-app user (a Sideline customer) + their OWN
//                     wallet balance. One row per (session, app id).
//   account_links  : the STX grant LINKED to an ISV user (account linking):
//                     the STX access/refresh tokens, keyed by user. This is the
//                     only place STX tokens ever live; they never reach the
//                     browser.
//   auth_flows     : transient PKCE verifier + CSRF state between /login and
//                     /callback, carrying which app + user the flow is for.
//   activity       : every request the backend makes to STX, for the API calls
//                     page.
//
// Rows carry the app id (APP_ID) they were made under; see adoptRetiredAppRows.

import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { config } from "./config";

// Ensure the directory for the SQLite file exists (e.g. the mounted ./data).
// An in-memory database (":memory:") has no directory. The directory is only
// made when absent: some Bun 1.1 builds fail a recursive mkdir of one that exists.
if (config.dbPath !== ":memory:" && !existsSync(dirname(config.dbPath))) {
  mkdirSync(dirname(config.dbPath), { recursive: true });
}

export const db = new Database(config.dbPath, { create: true });

// WAL improves concurrent read/write behaviour and is the sensible default.
// It is unavailable for :memory: databases, so guard it.
if (config.dbPath !== ":memory:") {
  db.exec("PRAGMA journal_mode = WAL;");
}

db.exec(`
  -- Mock ISV-app users and their OWN wallet. One row per (session, app id).
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,        -- opaque user id, FK target for links
    session_id   TEXT NOT NULL,           -- the browser session that owns them
    app_id       TEXT NOT NULL,           -- the app id it was made under (APP_ID)
    name         TEXT NOT NULL,           -- display name
    wallet_cents INTEGER NOT NULL,        -- the ISV-held balance, in cents
    created_at   INTEGER NOT NULL,
    UNIQUE (session_id, app_id)
  );

  -- The STX grant linked to an ISV user (account linking). Keyed by user, so a
  -- user has at most one STX link. Tokens live only here and never reach the
  -- browser. STX rotates refresh tokens, so refresh_token is overwritten in
  -- place on every refresh.
  CREATE TABLE IF NOT EXISTS account_links (
    user_id            TEXT PRIMARY KEY,
    app_id             TEXT NOT NULL,
    access_token       TEXT NOT NULL,
    refresh_token      TEXT,
    access_expires_at  INTEGER,          -- epoch ms; null if unknown
    scopes             TEXT,             -- space-delimited granted scopes
    linked_at          INTEGER NOT NULL, -- when the link was first established
    updated_at         INTEGER NOT NULL
  );

  -- In-flight authorization requests. Holds the PKCE verifier and CSRF state
  -- between /login and /callback, keyed by the one-time state value, and which
  -- app + user the resulting grant should be linked to.
  CREATE TABLE IF NOT EXISTS auth_flows (
    state          TEXT PRIMARY KEY,
    code_verifier  TEXT NOT NULL,
    session_id     TEXT NOT NULL,
    app_id         TEXT NOT NULL,
    user_id        TEXT NOT NULL,
    created_at     INTEGER NOT NULL
  );

  -- Activity log: every request this backend makes to STX, tagged with the app
  -- that made it, for the UI panel that demonstrates "track all ISV requests".
  CREATE TABLE IF NOT EXISTS activity (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,        -- epoch ms
    app_id      TEXT,                    -- which ISV app profile made the call
    method      TEXT NOT NULL,
    path        TEXT NOT NULL,
    status      INTEGER,                 -- HTTP status, null on transport error
    note        TEXT,                    -- e.g. "refreshed token", "error: ..."
    sdk_call    TEXT                     -- the @stxapp/stx-typescript call, as code; null on old rows
  );
`);

// ---- Defensive migration for a pre-Sideline database --------------------------
//
// A demo DB created before the Sideline rework may have `auth_flows` / `activity`
// without the columns added above. `CREATE TABLE IF NOT EXISTS` leaves an
// existing table untouched, so add any missing columns idempotently. Each ADD
// COLUMN throws if the column already exists; that is expected and ignored.
function addColumnIfMissing(table: string, column: string, ddl: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  } catch {
    // Column already present: nothing to do.
  }
}

addColumnIfMissing("auth_flows", "app_id", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("auth_flows", "user_id", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("activity", "app_id", "TEXT");
addColumnIfMissing("activity", "sdk_call", "TEXT");
// The redacted request/response behind a row (JSON, see activityDetail.ts) and
// the ISV user it was made for; both null on older rows and app-level calls.
addColumnIfMissing("activity", "detail", "TEXT");
addColumnIfMissing("activity", "user_id", "TEXT");
// Who the user is in whatever signed them in (see User.externalId), when there
// is an account behind them. A returning user is found by it from any browser,
// with their wallet and STX link.
addColumnIfMissing("users", "external_id", "TEXT");
addColumnIfMissing("users", "email", "TEXT");
// Sign-ins in progress for the `stx` and `vendor` login modes (see stores.ts).
db.exec(`
  CREATE TABLE IF NOT EXISTS signin_flows (
    state          TEXT PRIMARY KEY,
    code_verifier  TEXT NOT NULL,
    nonce          TEXT NOT NULL,
    session_id     TEXT NOT NULL,
    created_at     INTEGER NOT NULL
  );
`);
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS users_app_external ON users (app_id, external_id) WHERE external_id IS NOT NULL`,
);

// ---- Users from a Playbook database ------------------------------------------
//
// Playbook, before it became the `stx` login mode here, kept the member's STX
// id in its own column (`stx_sub`). A database from then is carried over: those
// users get the key the `stx` mode looks them up by, so they keep their wallet
// and STX link. A database that never had the column is left alone.
export function adoptPlaybookUsers(issuer: string): number {
  const columns = db.query(`PRAGMA table_info(users)`).all() as { name: string }[];
  if (!columns.some((c) => c.name === "stx_sub")) return 0;
  const { changes } = db
    .query(`UPDATE users SET external_id = $prefix || stx_sub WHERE stx_sub IS NOT NULL AND external_id IS NULL`)
    .run({ $prefix: `stx:${issuer.replace(/\/+$/, "")}|` });
  if (changes > 0) console.log(`Carried over ${changes} Playbook user(s).`);
  return changes;
}

adoptPlaybookUsers(config.stxLogin.issuer);

// ---- Re-home rows after an app is renamed -----------------------------------
//
// Every row names its app by id (users, account_links, auth_flows, activity).
// When a deployment's app id changes (APP_ID), existing members must keep their
// sign-in, wallet and STX link, so their rows move to the new id; nothing is
// dropped. An id is "retired" when rows carry it but the app no longer does.
// A user row that would collide with one already under the current id (same
// session) keeps its old id: stored, just not shown.
export function adoptRetiredAppRows(to: string): { from: string[]; to: string | null } {
  const retired = (
    db
      .query(
        `SELECT app_id FROM users UNION SELECT app_id FROM account_links
         UNION SELECT app_id FROM auth_flows WHERE app_id != ''
         UNION SELECT app_id FROM activity WHERE app_id IS NOT NULL`,
      )
      .all() as { app_id: string | null }[]
  )
    .map((r) => r.app_id)
    .filter((id): id is string => Boolean(id) && id !== to);
  if (retired.length === 0) return { from: [], to: null };
  db.transaction(() => {
    for (const from of retired) {
      const args = { $from: from, $to: to };
      db.query(`UPDATE OR IGNORE users SET app_id = $to WHERE app_id = $from`).run(args);
      // A link follows its user: re-home the links whose user moved.
      db.query(
        `UPDATE account_links SET app_id = $to
         WHERE app_id = $from AND user_id IN (SELECT id FROM users WHERE app_id = $to)`,
      ).run(args);
      db.query(`UPDATE auth_flows SET app_id = $to WHERE app_id = $from`).run(args);
      db.query(`UPDATE activity SET app_id = $to WHERE app_id = $from`).run(args);
    }
  })();
  console.log(`Moved rows from retired app ids ${retired.join(", ")} to ${to}.`);
  return { from: retired, to };
}

adoptRetiredAppRows(config.app.id);
