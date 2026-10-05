import { useEffect, useState } from "react";
import { api } from "../api";
import { useLiveAccount } from "../liveAccount";
import { fetchMarkets, marketDisplayLabel, type MarketSummary } from "../publicMarketData";
import { Orders } from "./Orders";
import { RecordsPanel, txt, priceCents, money, shortId, timeOf } from "./RecordsPanel";

// The member's own history. `activeTab` lets a parent (the header nav) control
// which view is shown as a full page; without it the component shows its own tab
// bar. Orders/trades/settlements reference markets by id; the public catalog is
// loaded once so each row can show the market's name instead of a bare id.
export type ActivityTab = "orders" | "trades" | "settlements";

const TABS: { id: ActivityTab; label: string }[] = [
  { id: "orders", label: "My orders" },
  { id: "trades", label: "My trades" },
  { id: "settlements", label: "Settlements" },
];

export function MyActivity({
  refreshKey,
  onChanged,
  activeTab,
}: {
  refreshKey: number;
  onChanged: () => void;
  activeTab?: ActivityTab;
}) {
  const [internalTab, setInternalTab] = useState<ActivityTab>("orders");
  // Fills pushed on the member's socket, merged over the REST trades page.
  const { fills: liveFills } = useLiveAccount();
  const tab = activeTab ?? internalTab;

  // market_id -> display name, from the public catalog (loaded once).
  const [markets, setMarkets] = useState<Map<string, MarketSummary>>(new Map());
  useEffect(() => {
    let cancelled = false;
    fetchMarkets()
      .then((list) => {
        if (!cancelled) setMarkets(new Map(list.map((m) => [m.marketId, m])));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const nameFor = (id: unknown): string | null => {
    const s = txt(id);
    if (!s) return null;
    const m = markets.get(s);
    return m ? marketDisplayLabel(m) : `Market ${shortId(s)}`;
  };

  return (
    <div className="card my-activity">
      {activeTab == null && (
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`tab${tab === t.id ? " active" : ""}`}
              onClick={() => setInternalTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      <div className="tab-body">
        {tab === "orders" && (
          <Orders refreshKey={refreshKey} onCancelled={onChanged} marketName={nameFor} embedded />
        )}
        {tab === "trades" && (
          <RecordsPanel
            fetcher={api.trades}
            keys={["fills", "trades"]}
            refreshKey={refreshKey}
            live={liveFills}
            what="your trades"
            empty="No trades yet."
            summarize={(t) => {
              const action = txt(t.action)?.toLowerCase();
              // A fill's filled size is `filled`; price is a dollar string; the
              // readable timestamp is the ISO `time` (not the µs `inserted_at`).
              const qty = txt(t.filled) ?? txt(t.quantity) ?? txt(t.remaining);
              return (
                <>
                  <div className="record-line">
                    {action && (
                      <span className={`badge badge-${action === "buy" ? "buy" : "sell"}`}>{action}</span>
                    )}
                    <span className="record-title">{nameFor(t.market_id) ?? "Trade"}</span>
                  </div>
                  <div className="record-line">
                    <span className="record-terms">
                      {qty ?? "?"}
                      {priceCents(t.price) ? ` @ ${priceCents(t.price)}` : ""}
                    </span>
                    <span className="record-meta">
                      {timeOf(t.time ?? t.inserted_at) && <span>{timeOf(t.time ?? t.inserted_at)}</span>}
                    </span>
                  </div>
                </>
              );
            }}
          />
        )}
        {tab === "settlements" && (
          <RecordsPanel
            fetcher={api.settlements}
            keys={["settlements"]}
            refreshKey={refreshKey}
            what="your settlements"
            empty="No settlements yet."
            summarize={(s) => (
              <>
                <div className="record-line">
                  <span className="record-title">{nameFor(s.market_id) ?? "Settlement"}</span>
                </div>
                <div className="record-line">
                  <span className="record-terms">
                    {money(s.amount ?? s.payout) && <strong>{money(s.amount ?? s.payout)}</strong>}
                  </span>
                  <span className="record-meta">
                    {timeOf(s.time ?? s.inserted_at) && <span>{timeOf(s.time ?? s.inserted_at)}</span>}
                  </span>
                </div>
              </>
            )}
          />
        )}
      </div>
    </div>
  );
}
