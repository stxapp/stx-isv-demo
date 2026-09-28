import { createContext, useContext, useEffect, useRef, useState } from "react";
import { liveStreamUrl } from "./api";

// The member's live STX account, from the backend's SSE stream (GET /api/stream).
// The backend keeps the SDK's `ws.accountView()` on the member's socket and
// relays it: a `state` event with the whole view (balance, open orders, fills,
// positions) when the stream opens, then one event per change carrying the
// updated part of the view. The wallet, open orders and trades render from
// here; nothing is refetched per event.
//
// REST stays for history (order history, trades, settlements): loaded once,
// and refreshed once after a reconnect. `resyncs` counts those reconnects
// (debounced), for the history lists to key their reload on.

export type LiveKind = "balances" | "fills" | "orders" | "positions";
export type Row = Record<string, unknown>;

export interface FeedItem {
  id: number;
  kind: LiveKind;
  label: string;
  ts: number;
}

export interface LiveAccount {
  // The SSE stream is open and the view is seeded.
  live: boolean;
  // The stream could not open (or the grant died): callers fall back to REST.
  failed: boolean;
  balance: Row | null;
  openOrders: Row[];
  fills: Row[];
  positions: Row[];
  // Every order the socket reported this session, latest version, by id: the
  // history list merges these over its REST page.
  orderUpdates: Map<string, Row>;
  // Incremental events worth showing in the "Live from STX" card, newest first,
  // the last ITEMS_KEPT of them. The card reads only the ones it has not seen.
  items: FeedItem[];
  // Reconnects so far (stream or STX socket), debounced; history reloads on it.
  resyncs: number;
}

const EMPTY: LiveAccount = {
  live: false,
  failed: false,
  balance: null,
  openOrders: [],
  fills: [],
  positions: [],
  orderUpdates: new Map(),
  items: [],
  resyncs: 0,
};

// Only the INCREMENTAL events are worth showing as they happen. The snapshots
// (on join, and again after a reconnect) seed state and are not listed.
const COPY: Record<string, string> = {
  "fills:trade": "Trade filled on STX",
  "orders:new_open_order": "Order resting on the book",
  "balances:update": "Balance updated",
  "balances:payment_update": "Deposit received",
  "positions:updated_positions": "Position updated",
};

// The orders channel sends every order change as `new_open_order`; the
// order's status says what happened.
const ORDER_COPY: Record<string, string> = {
  open: "Order resting on the book",
  accepted: "Order resting on the book",
  requested: "Order resting on the book",
  partially_filled: "Order partly filled",
  filled: "Order filled",
  cancelled: "Order cancelled",
  canceled: "Order cancelled",
  rejected: "Order rejected",
  expired: "Order expired",
};

function labelOf(c: { kind: LiveKind; event: string; snapshot: boolean; payload: unknown }): string | null {
  if (c.snapshot) return null;
  if (c.kind === "orders" && c.event === "new_open_order" && c.payload && typeof c.payload === "object") {
    const status = String((c.payload as Row).status ?? "").toLowerCase();
    if (ORDER_COPY[status]) return ORDER_COPY[status];
  }
  return COPY[`${c.kind}:${c.event}`] ?? null;
}

// A history refresh after a reconnect waits this long, so a burst of
// reconnects (stream and socket together) reloads once.
const RESYNC_DEBOUNCE_MS = 600;

const KINDS: LiveKind[] = ["balances", "fills", "orders", "positions"];

// Enough that a burst between two renders is never cut before the card sees it.
const ITEMS_KEPT = 100;

interface ChangeEvent {
  kind: LiveKind;
  event: string;
  snapshot: boolean;
  payload: unknown;
  state: { balance?: Row | null; openOrders?: Row[]; fills?: Row[]; positions?: Row[] };
  ts: number;
}

export function useLiveAccountStream(enabled: boolean): LiveAccount {
  const [state, setState] = useState<LiveAccount>(EMPTY);
  const seq = useRef(0);

  useEffect(() => {
    setState(EMPTY);
    if (!enabled) return;
    const es = new EventSource(liveStreamUrl(), { withCredentials: true });
    let seeds = 0;
    let resyncTimer: ReturnType<typeof setTimeout> | undefined;

    es.addEventListener("state", (ev) => {
      let data: { balance?: Row | null; openOrders?: Row[]; fills?: Row[]; positions?: Row[] };
      try {
        data = JSON.parse((ev as MessageEvent).data);
      } catch {
        return;
      }
      seeds += 1;
      const reconnect = seeds > 1;
      setState((s) => ({
        ...s,
        live: true,
        failed: false,
        balance: data.balance ?? null,
        openOrders: data.openOrders ?? [],
        fills: data.fills ?? [],
        positions: data.positions ?? [],
      }));
      if (reconnect) {
        clearTimeout(resyncTimer);
        resyncTimer = setTimeout(() => setState((s) => ({ ...s, resyncs: s.resyncs + 1 })), RESYNC_DEBOUNCE_MS);
      }
    });
    es.addEventListener("ready", () => setState((s) => ({ ...s, live: true, failed: false })));
    es.addEventListener("error", (ev) => {
      const data = (ev as MessageEvent).data;
      // A server-sent `error` (grant revoked, feed would not open) ends it; a
      // dropped connection is retried by EventSource and reseeds on `state`.
      if (typeof data === "string") {
        es.close();
        setState((s) => ({ ...s, live: false, failed: true }));
      } else {
        setState((s) => ({ ...s, live: false }));
      }
    });

    const onChange = (ev: Event) => {
      let c: ChangeEvent;
      try {
        c = JSON.parse((ev as MessageEvent).data);
      } catch {
        return;
      }
      const label = labelOf(c);
      setState((s) => {
        const next: LiveAccount = { ...s };
        if (c.state.balance !== undefined) next.balance = c.state.balance;
        if (c.state.openOrders) next.openOrders = c.state.openOrders;
        if (c.state.fills) next.fills = c.state.fills;
        if (c.state.positions) next.positions = c.state.positions;
        if (c.kind === "orders" && !c.snapshot && c.payload && typeof c.payload === "object") {
          const order = c.payload as Row;
          if (typeof order.id === "string") {
            next.orderUpdates = new Map(s.orderUpdates);
            next.orderUpdates.set(order.id, order);
          }
        }
        if (label) {
          next.items = [{ id: ++seq.current, kind: c.kind, label, ts: c.ts ?? Date.now() }, ...s.items].slice(0, ITEMS_KEPT);
        }
        return next;
      });
    };
    for (const k of KINDS) es.addEventListener(k, onChange);

    return () => {
      clearTimeout(resyncTimer);
      for (const k of KINDS) es.removeEventListener(k, onChange);
      es.close();
    };
  }, [enabled]);

  return state;
}

const LiveAccountContext = createContext<LiveAccount>(EMPTY);

export const LiveAccountProvider = LiveAccountContext.Provider;

export function useLiveAccount(): LiveAccount {
  return useContext(LiveAccountContext);
}

// Merge live rows over a REST page by id, newest first by `inserted_at`/`time`.
export function mergeById(rest: Row[], live: Iterable<Row>): Row[] {
  const byId = new Map<string, Row>();
  const keyOf = (r: Row) => String(r.id ?? r.order_id ?? "");
  const loose: Row[] = [];
  for (const r of rest) {
    const k = keyOf(r);
    if (k) byId.set(k, r);
    else loose.push(r);
  }
  for (const r of live) {
    const k = keyOf(r);
    if (k) byId.set(k, { ...byId.get(k), ...r });
  }
  return [...byId.values(), ...loose].sort((a, b) => stamp(b) - stamp(a));
}

function stamp(r: Row): number {
  const v = r.inserted_at ?? r.time;
  if (typeof v === "number") return v > 1e14 ? v / 1000 : v;
  const s = String(v ?? "");
  if (/^\d{13,19}$/.test(s)) return s.length >= 16 ? Number(s) / 1000 : Number(s);
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}
