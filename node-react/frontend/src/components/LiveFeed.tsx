import { useEffect, useRef, useState } from "react";
import { liveStreamUrl } from "../api";

// Live member feed. Opens an SSE stream to the ISV backend, which is joined to
// the member's private STX channels (balances / fills / orders / positions) and
// relays their events here in real time. When a balance or fill event arrives it
// also nudges the rest of the UI (wallet, activity) to refetch — so placing an
// order visibly updates the app with no refresh. The access token never reaches
// the browser; this only reads a same-origin event stream.

type Kind = "balances" | "fills" | "orders" | "positions";

interface FeedItem {
  id: number;
  kind: Kind;
  label: string;
  ts: number;
}

// Only the INCREMENTAL events are worth showing as they happen. Each channel
// also pushes a one-time snapshot on join (balances, all_trades, all_orders,
// all_positions) — those seed state elsewhere and would just clutter the feed,
// so anything not in this map is ignored for display.
const COPY: Record<string, string> = {
  "fills:trade": "Trade filled on STX",
  "orders:new_open_order": "Order resting on the book",
  "balances:update": "Balance updated",
  "balances:payment_update": "Deposit received",
  "positions:updated_positions": "Position updated",
};

function describe(kind: Kind, event: string): string | null {
  return COPY[`${kind}:${event}`] ?? null;
}

export function LiveFeed({ appId, onChange }: { appId: string; onChange: () => void }) {
  const [live, setLive] = useState(false);
  const [items, setItems] = useState<FeedItem[]>([]);
  const seq = useRef(0);
  // Keep the refetch callback in a ref so the stream opens once per app, not on
  // every parent render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    setItems([]);
    setLive(false);
    const es = new EventSource(liveStreamUrl(appId), { withCredentials: true });

    es.addEventListener("ready", () => setLive(true));
    es.addEventListener("error", () => setLive(false));

    const onKind = (kind: Kind) => (ev: MessageEvent) => {
      let data: { event?: string; ts?: number } = {};
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      const label = describe(kind, data.event ?? "");
      if (!label) return; // snapshot / non-display event
      const item: FeedItem = { id: ++seq.current, kind, label, ts: data.ts ?? Date.now() };
      setItems((prev) => [item, ...prev].slice(0, 15));
      // A balance or fill/order changes what the wallet + activity show.
      if (kind !== "positions") onChangeRef.current();
    };

    const kinds: Kind[] = ["balances", "fills", "orders", "positions"];
    const handlers = kinds.map((k) => {
      const h = onKind(k);
      es.addEventListener(k, h as EventListener);
      return [k, h] as const;
    });

    return () => {
      handlers.forEach(([k, h]) => es.removeEventListener(k, h as EventListener));
      es.close();
    };
  }, [appId]);

  return (
    <div className="card live-feed">
      <div className="live-head">
        <h3>Live from STX</h3>
        <span className={`live-dot${live ? " on" : ""}`}>{live ? "● Live" : "○ connecting"}</span>
      </div>
      {items.length === 0 ? (
        <p className="muted live-empty">
          Connected to your STX channels. Place an order and watch it land here in real time.
        </p>
      ) : (
        <ul className="live-list">
          {items.map((it) => (
            <li key={it.id} className={`live-item live-${it.kind}`}>
              <span className="live-pulse" aria-hidden="true" />
              <span className="live-label">{it.label}</span>
              <span className="live-time">{new Date(it.ts).toLocaleTimeString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
