import { Fragment, useEffect, useState } from "react";
import { api, type ActivityBody, type ActivityDetail, type ActivityRecord } from "../api";

// "Track all ISV requests": every call the backend makes to STX is logged and
// surfaced here, with the STX TypeScript SDK call behind it. A row with a
// stored detail expands to the request and response (redacted by the backend
// before storage: no tokens, secrets, codes or keys). Polls every few seconds
// and also refetches on refreshKey.
export function ActivityPanel({ refreshKey, embedded = false }: { refreshKey: number; embedded?: boolean }) {
  const [rows, setRows] = useState<ActivityRecord[]>([]);
  const [open, setOpen] = useState<Set<number>>(() => new Set());

  function toggle(id: number) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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
      <>
      <p className="sdk-note muted">
        Calls made through the STX TypeScript SDK (<code>@stxapp/stx-typescript</code>). Open a row for its request and
        response; tokens and secrets are redacted.
      </p>
      <table className="activity">
          <thead>
            <tr>
              <th>Time</th>
              <th>Activity</th>
              <th>Status</th>
              <th>Endpoint</th>
              <th>TypeScript SDK call</th>
              <th>
                <span className="visually-hidden">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const expanded = open.has(r.id);
              const toggleRow = r.hasDetail ? () => toggle(r.id) : undefined;
              return (
                <Fragment key={r.id}>
                  <tr
                    className={`${r.hasDetail ? "has-detail" : ""}${expanded ? " expanded" : ""}`}
                    onClick={(e) => {
                      // A click on the row toggles it; the copy button and the
                      // details button handle their own clicks.
                      if ((e.target as HTMLElement).closest("button")) return;
                      toggleRow?.();
                    }}
                  >
                    <td>{new Date(r.ts).toLocaleTimeString()}</td>
                    <td className="activity-label">{describe(r)}</td>
                    <td className={statusClass(r.status)}>{ok(r.status) ? "OK" : (r.status ?? "-")}</td>
                    <td className="path muted">
                      <code>{r.method} {r.path}</code>
                    </td>
                    <td className="sdk-call">
                      {r.sdkCall ? <SdkCall code={r.sdkCall} /> : null}
                    </td>
                    <td className="detail-toggle-cell">
                      {r.hasDetail ? (
                        <button
                          type="button"
                          className="detail-toggle"
                          aria-expanded={expanded}
                          aria-controls={`activity-detail-${r.id}`}
                          onClick={() => toggle(r.id)}
                        >
                          <span className="chev" aria-hidden="true">{expanded ? "▾" : "▸"}</span> Details
                        </button>
                      ) : null}
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="activity-detail-row" id={`activity-detail-${r.id}`}>
                      <td colSpan={6}>
                        <DetailView id={r.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
      </table>
      </>
    );

  if (embedded) return body;
  return (
    <div className="card">
      <h3>Activity</h3>
      {body}
    </div>
  );
}

// The request and response behind one row, fetched when the row is opened.
function DetailView({ id }: { id: number }) {
  const [state, setState] = useState<{ detail?: ActivityDetail | null; error?: string }>({});
  useEffect(() => {
    let alive = true;
    api
      .activityDetail(id)
      .then((r) => alive && setState({ detail: r.detail }))
      .catch((e) => alive && setState({ error: String(e) }));
    return () => {
      alive = false;
    };
  }, [id]);

  if (state.error) return <p className="error">Could not load the details: {state.error}</p>;
  if (state.detail === undefined) return <p className="muted">Loading…</p>;
  if (state.detail === null) return <p className="muted">No request or response was recorded for this call.</p>;
  const { request, response, note } = state.detail;
  return (
    <div className="activity-detail">
      {note && <p className="muted detail-note">{note}</p>}
      {request && (
        <section>
          <h4>Request</h4>
          <p className="detail-line">
            <code>
              {request.method} {request.path}
            </code>
          </p>
          {request.query && Object.keys(request.query).length > 0 && (
            <>
              <p className="detail-label">Query</p>
              <pre className="json">{JSON.stringify(request.query, null, 2)}</pre>
            </>
          )}
          <Body side={request} empty="No request body." />
        </section>
      )}
      {response && (
        <section>
          <h4>Response</h4>
          <p className="detail-line">
            <span className={statusClass(response.status)}>
              {response.status ?? (request?.method === "JOIN" ? "join reply" : "no status")}
            </span>
            {response.summary && <span className="muted"> · {response.summary}</span>}
          </p>
          <Body side={response} empty="No response body." />
        </section>
      )}
    </div>
  );
}

function Body({ side, empty }: { side: ActivityBody; empty: string }) {
  if (side.body === undefined) return <p className="muted detail-empty">{empty}</p>;
  const text = typeof side.body === "string" ? side.body : JSON.stringify(side.body, null, 2);
  return (
    <>
      <pre className="json detail-json">{text}</pre>
      {side.truncated && (
        <p className="muted detail-trunc">
          Truncated: showing the first {Math.round(text.length / 1024)} KB of {Math.round((side.size ?? 0) / 1024)} KB.
        </p>
      )}
    </>
  );
}

// The SDK call as code, with a copy button.
function SdkCall({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  }
  return (
    <span className="sdk-call-wrap">
      <code>{code}</code>
      <button type="button" className="sdk-copy" onClick={copy} title="Copy SDK call" aria-label="Copy SDK call">
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
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
  if (p.includes("/orders")) {
    if (r.method === "GET") return "Loaded order history";
    return r.method === "DELETE" ? "Cancelled an order" : "Placed an order";
  }
  return `${r.method} ${p}`;
}

function statusClass(status: number | null): string {
  if (status == null) return "status";
  if (status >= 500) return "status s5";
  if (status >= 400) return "status s4";
  return "status s2";
}
