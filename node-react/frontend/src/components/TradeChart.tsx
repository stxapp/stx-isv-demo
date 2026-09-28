import { useEffect, useMemo, useState } from "react";
import type { TradeMsg } from "../publicMarketData";

// A small price chart for one market, drawn from its trades (the same data as
// the tape: REST `recent_trades` plus live `trades` pushes). Each execution is a
// step; the line holds the last price out to "now". Plain inline SVG, no chart
// library. Prices read as cents on a $1 market, dollars on a larger one.

const W = 600;
const H = 150;
const PAD_X = 8;
const PAD_Y = 14;

interface Props {
  trades: TradeMsg[]; // newest first
  loading: boolean;
  // The market's settlement ceiling in cents (100 = a $1 market).
  maxPriceCents: number | null;
}

export function TradeChart({ trades, loading, maxPriceCents }: Props) {
  // Re-render every 30 s so the "now" edge keeps moving.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const bigMarket = (maxPriceCents ?? 100) > 100;
  const fmt = (dollarsValue: number) =>
    bigMarket ? `$${dollarsValue.toFixed(2)}` : `${Math.round(dollarsValue * 100)}¢`;

  const geom = useMemo(() => {
    const pts = trades
      .map((t) => ({ t: t.timestamp_us / 1000, p: Number(t.price) }))
      .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.p))
      .sort((a, b) => a.t - b.t);
    if (pts.length === 0) return null;
    const tMin = pts[0].t;
    const tMax = Math.max(now, pts[pts.length - 1].t);
    const ps = pts.map((x) => x.p);
    const ceiling = (maxPriceCents ?? 100) / 100;
    const spread = Math.max(...ps) - Math.min(...ps);
    const pad = Math.max(ceiling * 0.05, spread * 0.25);
    const pLo = Math.max(0, Math.min(...ps) - pad);
    const pHi = Math.min(ceiling, Math.max(...ps) + pad);
    const x = (t: number) => (tMax === tMin ? W - PAD_X : PAD_X + ((t - tMin) / (tMax - tMin)) * (W - 2 * PAD_X));
    const y = (p: number) => PAD_Y + (1 - (p - pLo) / (pHi - pLo || 1)) * (H - 2 * PAD_Y);
    // Step-after: hold each price until the next trade, then out to now.
    let d = `M${x(pts[0].t).toFixed(1)} ${y(pts[0].p).toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      d += ` H${x(pts[i].t).toFixed(1)} V${y(pts[i].p).toFixed(1)}`;
    }
    const last = pts[pts.length - 1];
    d += ` H${(W - PAD_X).toFixed(1)}`;
    const area = `${d} V${H} H${x(pts[0].t).toFixed(1)} Z`;
    const first = pts[0];
    const change = last.p - first.p;
    return {
      d,
      area,
      lastY: y(last.p),
      hi: Math.max(...ps),
      lo: Math.min(...ps),
      last: last.p,
      change,
      since: first.t,
      count: pts.length,
    };
  }, [trades, now, maxPriceCents]);

  return (
    <div className="card trade-chart">
      <div className="card-title-row">
        <h3>Price</h3>
        {geom && (
          <span className="trade-chart-last">
            {fmt(geom.last)}
            {geom.count > 1 && geom.change !== 0 && (
              <span className={geom.change > 0 ? "pos" : "neg"}>
                {" "}
                {geom.change > 0 ? "+" : "-"}
                {fmt(Math.abs(geom.change))}
              </span>
            )}
          </span>
        )}
      </div>
      {geom ? (
        <>
          <svg
            className="trade-chart-svg"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Price over the last ${geom.count} trades, last ${fmt(geom.last)}`}
          >
            <path d={geom.area} className="trade-chart-area" />
            <path d={geom.d} className="trade-chart-line" vectorEffect="non-scaling-stroke" />
            <line
              x1={PAD_X}
              x2={W - PAD_X}
              y1={geom.lastY}
              y2={geom.lastY}
              className="trade-chart-lastline"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <div className="trade-chart-foot muted">
            <span>
              {geom.count} trade{geom.count === 1 ? "" : "s"} since {formatWhen(geom.since)}
            </span>
            <span>
              Low {fmt(geom.lo)} · High {fmt(geom.hi)}
            </span>
          </div>
        </>
      ) : (
        <p className="muted">{loading ? "Loading…" : "No trades yet, so no price history to draw."}</p>
      )}
    </div>
  );
}

function formatWhen(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}
