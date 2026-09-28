import { track } from "../analytics";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { mergeById, useLiveAccount } from "../liveAccount";
import { NotConnected } from "./NotConnected";

// Open orders come from the live feed (the SDK's account view on the member's
// socket): they appear, fill and disappear as STX pushes them, with no refetch.
// History is REST (GET /api/v1/orders), loaded once and again after a
// reconnect (`refreshKey`), with the orders the socket reported merged over it.
//
// Best-effort extraction of the fields STX returns on GET /api/v1/orders. The
// demo does not hard-code a schema: it pulls the common fields when present and
// keeps the full row available in a collapsible, so an unfamiliar shape still
// renders cleanly instead of spilling raw JSON across the layout.
interface LooseOrder {
  [key: string]: unknown;
  id?: string;
  order_id?: string;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v);
}

function orderId(o: LooseOrder): string | null {
  return str(o.id) ?? str(o.order_id);
}

// STX REST order prices are dollar strings ("0.9900"); show them as cents
// (0.99 -> "99¢").
function fmtPrice(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? `${Math.round(n * 100)}¢` : s;
}

// Prefer the ISO `time`; tolerate a bare µs/ms epoch (`inserted_at`) rather than
// printing the raw number.
function fmtTime(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  if (/^\d{10,19}$/.test(s)) {
    const d = s.length;
    const ms = d >= 16 ? Number(s) / 1000 : d >= 13 ? Number(s) : Number(s) * 1000;
    const dt = new Date(ms);
    return Number.isNaN(dt.getTime()) ? s : dt.toLocaleString();
  }
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? s : dt.toLocaleString();
}

function ordersFrom(payload: unknown): LooseOrder[] {
  if (Array.isArray(payload)) return payload as LooseOrder[];
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    // Common envelope shapes: { orders: [...] } / { data: [...] }.
    for (const key of ["orders", "data", "results"]) {
      if (Array.isArray(obj[key])) return obj[key] as LooseOrder[];
    }
  }
  return [];
}

// Terminal statuses: the order is no longer resting on the book, so cancelling
// it is a no-op at best and an error at worst. Anything else (open,
// partially_filled, pending, or an unknown/blank status) is treated as still
// open: that is where the Cancel button lives.
const TERMINAL_STATUSES = new Set([
  "filled",
  "cancelled",
  "canceled",
  "rejected",
  "expired",
  "settled",
  "closed",
  "complete",
  "completed",
  "done",
  "matched",
]);

function isOpenOrder(o: LooseOrder): boolean {
  const s = str(o.status)?.toLowerCase();
  if (!s) return true;
  return !TERMINAL_STATUSES.has(s);
}

export function Orders({
  refreshKey,
  onCancelled,
  marketName,
  embedded = false,
}: {
  refreshKey: number;
  onCancelled: () => void;
  marketName?: (id: unknown) => string | null;
  embedded?: boolean;
}) {
  const [payload, setPayload] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [notLinked, setNotLinked] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<"open" | "history">("open");

  const load = useCallback(() => {
    setError(null);
    setNotLinked(false);
    api
      .orders()
      .then(setPayload)
      .catch((e) => {
        if (e instanceof ApiError && e.notLinked) setNotLinked(true);
        else setError(e instanceof ApiError ? e.message : String(e));
      });
  }, []);

  useEffect(load, [load, refreshKey]);

  const liveAccount = useLiveAccount();

  async function cancel(id: string) {
    setBusy(id);
    try {
      await api.cancelOrder(id);
      track("order_cancel");
      onCancelled();
      // The live feed drops the order on its own; without it, reload.
      if (!liveAccount.live) load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  const allOrders = mergeById(ordersFrom(payload) as LooseOrder[], liveAccount.orderUpdates.values()) as LooseOrder[];
  const liveOpen = new Set(liveAccount.openOrders.map((o) => String(o.id)));
  const openOrders = liveAccount.live ? (liveAccount.openOrders as LooseOrder[]) : allOrders.filter(isOpenOrder);
  const historyOrders = allOrders.filter((o) => !isOpenOrder(o) && !liveOpen.has(String(orderId(o))));
  const MAX = 12;
  const active = subTab === "open" ? openOrders : historyOrders;
  const orders = active.slice(0, MAX);

  const body = notLinked ? (
    <NotConnected what="your orders" />
  ) : (
    <>
      {error && <p className="error">{error}</p>}
      {/* Open vs History: cancelling only makes sense on a resting order, so the
          Cancel button lives only in the Open tab: no accidental cancel on a
          filled or already-cancelled order. */}
      <div className="tabs tabs-sub" role="tablist">
        <button
          role="tab"
          aria-selected={subTab === "open"}
          className={`tab${subTab === "open" ? " active" : ""}`}
          onClick={() => setSubTab("open")}
        >
          Open{openOrders.length ? ` (${openOrders.length})` : ""}
        </button>
        <button
          role="tab"
          aria-selected={subTab === "history"}
          className={`tab${subTab === "history" ? " active" : ""}`}
          onClick={() => setSubTab("history")}
        >
          History{historyOrders.length ? ` (${historyOrders.length})` : ""}
        </button>
      </div>
      {active.length === 0 ? (
        <p className="muted">
          {subTab === "open" ? "No open orders." : "No past orders yet."}
        </p>
      ) : (
        <ul className="order-list">
          {orders.map((o, i) => {
            const id = orderId(o);
            const action = str(o.action)?.toLowerCase();
            const price = fmtPrice(o.price);
            const qty = str(o.quantity) ?? str(o.amount) ?? str(o.filled);
            const status = str(o.status);
            const time = fmtTime(o.time ?? o.inserted_at);
            const name = marketName?.(o.market_id);
            return (
              <li key={id ?? i} className="order-card">
                <div className="order-head">
                  {action && (
                    <span className={`badge badge-${action === "buy" ? "buy" : "sell"}`}>
                      {action}
                    </span>
                  )}
                  {name && <span className="order-title">{name}</span>}
                  {status && <span className="badge badge-status">{status}</span>}
                  {id && subTab === "open" && (
                    <button
                      className="link danger order-cancel"
                      disabled={busy === id}
                      onClick={() => cancel(id)}
                    >
                      {busy === id ? "Cancelling…" : "Cancel"}
                    </button>
                  )}
                </div>
                <div className="order-meta">
                  <span className="order-terms">
                    {qty ?? "?"}
                    {price ? ` @ ${price}` : ""}
                  </span>
                  {time && <span>{time}</span>}
                </div>
                <details className="order-raw">
                  <summary>raw</summary>
                  <pre className="order-json">{JSON.stringify(o, null, 2)}</pre>
                </details>
              </li>
            );
          })}
        </ul>
      )}
      {active.length > MAX && (
        <p className="muted list-more">Showing the {MAX} most recent of {active.length}.</p>
      )}
    </>
  );

  if (embedded) return body;
  return (
    <div className="card">
      <h3>Open orders</h3>
      {body}
    </div>
  );
}
