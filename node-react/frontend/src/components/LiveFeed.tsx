import { useLiveAccount } from "../liveAccount";

// Live member feed. The ISV backend keeps a live view of the member's STX
// account from its socket (balances / fills / orders / positions) and relays it
// over SSE; `useLiveAccount` holds it app-wide. This card lists the changes as
// they happen. The wallet, open orders and trades update from the same stream,
// with no refetch. The access token never reaches the browser.

export function LiveFeed() {
  const { live, items } = useLiveAccount();

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
