import { useEffect, useState } from "react";
import { api, type ActivityRecord } from "../api";

// "Track all ISV requests": every call the backend makes to STX is logged and
// surfaced here. Polls every few seconds and also refetches on refreshKey.
export function ActivityPanel({ refreshKey, embedded = false }: { refreshKey: number; embedded?: boolean }) {
  const [rows, setRows] = useState<ActivityRecord[]>([]);

  function load() {
    api
      .activity()
      .then((r) => setRows(r.activity))
      .catch(() => {});
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [refreshKey]);

  const body =
    rows.length === 0 ? (
        <p className="muted">No activity yet.</p>
    ) : (
      <table className="activity">
          <thead>
            <tr>
              <th>Time</th>
              <th>Activity</th>
              <th>Status</th>
              <th>Endpoint</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.ts).toLocaleTimeString()}</td>
                <td className="activity-label">{describe(r)}</td>
                <td className={statusClass(r.status)}>{ok(r.status) ? "OK" : (r.status ?? "—")}</td>
                <td className="path muted">
                  <code>{r.method} {r.path}</code>
                </td>
              </tr>
            ))}
          </tbody>
      </table>
    );

  if (embedded) return body;
  return (
    <div className="card">
      <h3>Activity</h3>
      {body}
    </div>
  );
}

function ok(status: number | null): boolean {
  return status != null && status >= 200 && status < 300;
}

// A plain-English description of one activity row. Prefer the backend-supplied
// label (r.note); otherwise fall back to a phrase derived from the endpoint, so
// the log reads as member activity rather than raw API calls.
function describe(r: ActivityRecord): string {
  if (r.note && r.note.trim() !== "") return r.note;
  const p = r.path;
  if (p.includes("/oauth/token")) return "Refreshed access";
  if (p.includes("/account/balance")) return "Checked STX balance";
  if (p.includes("/fills")) return "Loaded trades";
  if (p.includes("/settlements")) return "Loaded settlements";
  if (p.includes("/orders")) return r.method === "GET" ? "Loaded order history" : "Placed an order";
  if (p.includes("/graphql")) return "Traded on STX";
  return `${r.method} ${p}`;
}

function statusClass(status: number | null): string {
  if (status == null) return "status";
  if (status >= 500) return "status s5";
  if (status >= 400) return "status s4";
  return "status s2";
}
