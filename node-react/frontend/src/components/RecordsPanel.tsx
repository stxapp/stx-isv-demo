import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api";
import { mergeById } from "../liveAccount";
import { NotConnected } from "./NotConnected";

// A generic read-only list of STX records (trades, settlements, …). Tolerant of
// the response envelope and schema: it pulls an array out of the common shapes
// and renders each row as a compact summary with the full JSON behind a toggle,
// so an unfamiliar field never breaks the layout. `live` rows (fills pushed on
// the member's socket) are merged over the REST page by id, so the list moves
// without a refetch; `refreshKey` reloads the REST page (after a reconnect).
type Row = Record<string, unknown>;

function rowsFrom(payload: unknown, keys: string[]): Row[] {
  if (Array.isArray(payload)) return payload as Row[];
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const k of [...keys, "data", "results"]) {
      if (Array.isArray(obj[k])) return obj[k] as Row[];
    }
  }
  return [];
}

export function RecordsPanel({
  fetcher,
  keys,
  refreshKey,
  summarize,
  empty,
  what,
  live,
}: {
  fetcher: () => Promise<unknown>;
  keys: string[];
  refreshKey: number;
  summarize: (row: Row) => React.ReactNode;
  empty: string;
  what?: string;
  live?: Row[];
}) {
  const [payload, setPayload] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [notLinked, setNotLinked] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    setNotLinked(false);
    fetcher()
      .then(setPayload)
      .catch((e) => {
        if (e instanceof ApiError && e.notLinked) setNotLinked(true);
        else setError(e instanceof ApiError ? e.message : String(e));
      })
      .finally(() => setLoading(false));
  }, [fetcher]);

  useEffect(load, [load, refreshKey]);

  const restRows = rowsFrom(payload, keys);
  const allRows = live && live.length ? mergeById(restRows, live) : restRows;
  const MAX = 12;
  const rows = allRows.slice(0, MAX);

  if (loading) return <p className="muted">Loading…</p>;
  if (notLinked) return <NotConnected what={what} />;
  if (error) return <p className="error">{error}</p>;
  if (allRows.length === 0) return <p className="muted">{empty}</p>;

  return (
    <>
      <ul className="record-list">
        {rows.map((row, i) => (
          <li key={i} className="record-card">
            <div className="record-summary">{summarize(row)}</div>
            <details className="record-raw">
              <summary>raw</summary>
              <pre className="json">{JSON.stringify(row, null, 2)}</pre>
            </details>
          </li>
        ))}
      </ul>
      {allRows.length > MAX && (
        <p className="muted list-more">Showing the {MAX} most recent of {allRows.length}.</p>
      )}
    </>
  );
}

// Shared cell formatters for the summaries.
export function txt(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v);
}
// STX REST money fields are dollar strings ("0.6000", "2.4000"). A price shows
// as cents (0.60 -> "60¢"); an amount shows as dollars (2.40 -> "$2.40").
export function priceCents(v: unknown): string | null {
  const s = txt(v);
  if (s === null) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? `${Math.round(n * 100)}¢` : s;
}
export function money(v: unknown): string | null {
  const s = txt(v);
  if (s === null) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : s;
}
export function shortId(v: unknown): string | null {
  const s = txt(v);
  if (s === null) return null;
  return s.length > 10 ? `${s.slice(0, 8)}…` : s;
}
export function timeOf(v: unknown): string | null {
  const s = txt(v);
  if (s === null) return null;
  // A bare epoch number: seconds (10 digits), millis (13), or micros (16, what
  // STX's `inserted_at` uses). `new Date("<digits>")` would fail to parse, so
  // normalize to millis first; otherwise treat as an ISO/parseable string.
  if (/^\d{10,19}$/.test(s)) {
    const d = s.length;
    const ms = d >= 16 ? Number(s) / 1000 : d >= 13 ? Number(s) : Number(s) * 1000;
    const dt = new Date(ms);
    return Number.isNaN(dt.getTime()) ? s : dt.toLocaleString();
  }
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? s : dt.toLocaleString();
}
