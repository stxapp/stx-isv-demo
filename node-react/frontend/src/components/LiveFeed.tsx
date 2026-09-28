import { useEffect, useRef, useState } from "react";
import { useLiveAccount, type FeedItem, type LiveKind } from "../liveAccount";

// Live member feed. The ISV backend keeps a live view of the member's STX
// account from its socket (balances / fills / orders / positions) and relays it
// over SSE; `useLiveAccount` holds it app-wide. This card lists the changes as
// they happen. The wallet, open orders and trades update from the same stream,
// with no refetch. The access token never reaches the browser.
//
// An active account (a bot, or a busy member) can send several events a second.
// So that the card stays readable without hiding anything:
// - consecutive events of the same type share one row with a count and the
//   latest time ("Position updated ×12");
// - a new row appears at most every ROW_GAP_MS; events arriving faster wait in
//   a queue, which collapses the same way. A backlog longer than MAX_QUEUE is
//   grouped by type, so the card never lags far behind and nothing is dropped;
// - while the pointer is over the list (or it has keyboard focus) no row moves;
//   a "Paused" hint shows how many are waiting, and they land on leaving;
// - the list keeps the latest MAX_ROWS rows.

const ROW_GAP_MS = 900;
const MAX_ROWS = 20;
const MAX_QUEUE = 4;

interface Row {
  key: number;
  kind: LiveKind;
  label: string;
  count: number;
  ts: number;
}

function toRow(it: FeedItem): Row {
  return { key: it.id, kind: it.kind, label: it.label, count: 1, ts: it.ts };
}

// One row per event type, in order of first appearance, counts summed.
function groupByType(rows: Row[]): Row[] {
  const out: Row[] = [];
  for (const r of rows) {
    const i = out.findIndex((o) => o.label === r.label);
    if (i < 0) out.push(r);
    else out[i] = { ...out[i], count: out[i].count + r.count, ts: Math.max(out[i].ts, r.ts) };
  }
  return out;
}

// Fold `row` into `head` when they are the same type of event.
function merge(head: Row | undefined, row: Row): Row | null {
  if (!head || head.label !== row.label) return null;
  return { ...head, count: head.count + row.count, ts: Math.max(head.ts, row.ts) };
}

export function LiveFeed() {
  const { live, items } = useLiveAccount();
  const [rows, setRows] = useState<Row[]>([]);
  // Oldest first: the next row to show is queue[0].
  const [queue, setQueue] = useState<Row[]>([]);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const lastSeen = useRef(0);
  const lastShown = useRef(0);

  // New stream items join the queue, merged into its tail when they repeat it.
  useEffect(() => {
    const fresh = items.filter((it) => it.id > lastSeen.current).reverse();
    if (fresh.length === 0) return;
    lastSeen.current = fresh[fresh.length - 1].id;
    setQueue((q) => {
      const next = [...q];
      for (const it of fresh) {
        const row = toRow(it);
        const merged = merge(next[next.length - 1], row);
        if (merged) next[next.length - 1] = merged;
        else next.push(row);
      }
      return next.length > MAX_QUEUE ? groupByType(next) : next;
    });
  }, [items]);

  // Drain the queue: the head of the list updates in place at once; a new row
  // waits for its slot. Nothing moves while paused.
  useEffect(() => {
    if (paused || queue.length === 0) return;
    const [first, ...rest] = queue;
    const mergesIntoHead = rows.length > 0 && rows[0].label === first.label;
    const wait = mergesIntoHead ? 0 : Math.max(0, lastShown.current + ROW_GAP_MS - Date.now());
    const t = setTimeout(() => {
      setQueue(rest);
      setRows((r) => {
        const merged = merge(r[0], first);
        if (merged) return [merged, ...r.slice(1)];
        lastShown.current = Date.now();
        return [first, ...r].slice(0, MAX_ROWS);
      });
    }, wait);
    return () => clearTimeout(t);
  }, [queue, rows, paused]);

  const waiting = queue.reduce((n, r) => n + r.count, 0);

  return (
    <div className="card live-feed">
      <div className="live-head">
        <h3>Live from STX</h3>
        {paused && rows.length > 0 ? (
          <span className="live-paused" role="status">
            Paused{waiting > 0 ? ` · ${waiting} new` : ""}
          </span>
        ) : (
          <span className={`live-dot${live ? " on" : ""}`}>{live ? "● Live" : "○ connecting"}</span>
        )}
      </div>
      {rows.length === 0 && queue.length === 0 ? (
        <p className="muted live-empty">
          Connected to your STX channels. Place an order and watch it land here in real time.
        </p>
      ) : (
        <ul
          className="live-list"
          tabIndex={0}
          aria-label="Live account events, newest first"
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        >
          {rows.map((r) => (
            <li key={r.key} className={`live-item live-${r.kind}`}>
              <span className="live-pulse" aria-hidden="true" />
              <span className="live-label">
                {r.label}
                {r.count > 1 && (
                  <span key={r.count} className="live-count" aria-label={`${r.count} times`}>
                    ×{r.count}
                  </span>
                )}
              </span>
              <span className="live-time">{new Date(r.ts).toLocaleTimeString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
