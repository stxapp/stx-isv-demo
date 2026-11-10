// Every activity row of an app, newest first, whoever it belongs to: what a
// test inspects. The app lists rows per viewer (activityStore.list).
import type { Database } from "bun:sqlite";

export interface ActivityRow {
  id: number;
  ts: number;
  appId: string;
  method: string;
  path: string;
  status: number | null;
  note: string | null;
  sdkCall: string | null;
  userId: string | null;
  hasDetail: boolean;
}

export function allActivity(db: Database, appId: string, limit = 500): ActivityRow[] {
  const rows = db
    .query(
      `SELECT id, ts, app_id AS appId, method, path, status, note, sdk_call AS sdkCall, user_id AS userId,
              (detail IS NOT NULL) AS hasDetail
       FROM activity WHERE app_id = $app ORDER BY id DESC LIMIT $limit`,
    )
    .all({ $app: appId, $limit: limit }) as (Omit<ActivityRow, "hasDetail"> & { hasDetail: number })[];
  return rows.map((r) => ({ ...r, hasDetail: r.hasDetail === 1 }));
}
