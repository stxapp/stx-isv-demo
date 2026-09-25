import { useEffect, useMemo, useState } from "react";
import { subscribeMarketStats } from "../marketFeed";

// A price-history chart for a money-line's two sides, fed by STX's public
// `market_stats` channel relayed over the backend SSE proxy. A money line is two
// markets (one per outcome, e.g.
// DET and CHW), each with its own book and its own `price_percent` series, so
// the chart draws one line per side: the STX site's two-line view. The whole
// history arrives in the join reply, then changed buckets (and full snapshots)
// stream in. `price_percent` is a rescaled price (0–100), read as the market's
// implied probability. Switching range rejoins.

interface Point {
  t: number; // timestamp, microseconds
  p: number; // price_percent, 0–100
}

export interface ChartSeries {
  marketId: string;
  label: string;
  color: string;
}

type Range = "day" | "week" | "month";
const RANGES: { id: Range; label: string }[] = [
  { id: "day", label: "1D" },
  { id: "week", label: "1W" },
  { id: "month", label: "1M" },
];

interface RawPoint {
  timestamp_us?: number | string;
  price_percent?: number | string;
}

function parse(pts: RawPoint[] | undefined): Point[] {
  return (pts ?? [])
    .map((pt) => ({ t: Number(pt.timestamp_us), p: Number(pt.price_percent) }))
    .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.p))
    .sort((a, b) => a.t - b.t);
}

export function PriceChart({
  series,
  title,
}: {
  series: ChartSeries[];
  title?: string;
}) {
  const [byMarket, setByMarket] = useState<Record<string, Point[]>>({});
  const [range, setRange] = useState<Range>("week");
  const [status, setStatus] = useState<"connecting" | "ok" | "error">("connecting");

  // Stable key so the effect re-subscribes only when the set of markets or the
  // range changes, not on every render.
  const idsKey = series.map((s) => s.marketId).join(",");

  useEffect(() => {
    const ids = idsKey ? idsKey.split(",") : [];
    if (ids.length === 0) return;
    setByMarket({});
    setStatus("connecting");

    const close = subscribeMarketStats(ids, range, {
      // The join reply seeds the whole history.
      onSeed: (markets) => {
        const next: Record<string, Point[]> = {};
        for (const m of markets) if (m.market_id) next[m.market_id] = parse(m.points);
        setByMarket(next);
        setStatus("ok");
      },
      // A snapshot replaces that market's series wholesale.
      onSnapshot: (pl) => {
        if (pl.market_id) setByMarket((prev) => ({ ...prev, [pl.market_id as string]: parse(pl.points) }));
      },
      // A delta upserts changed buckets by timestamp.
      onDelta: (pl) => {
        if (!pl.market_id) return;
        const fresh = parse(pl.points);
        setByMarket((prev) => {
          const cur = prev[pl.market_id as string] ?? [];
          const map = new Map(cur.map((x) => [x.t, x]));
          for (const f of fresh) map.set(f.t, f);
          return { ...prev, [pl.market_id as string]: [...map.values()].sort((a, b) => a.t - b.t) };
        });
      },
      onStatus: (s) => setStatus(s === "error" ? "error" : s === "open" ? "ok" : "connecting"),
    });

    return close;
  }, [idsKey, range]);

  const geom = useMemo(() => {
    const W = 600;
    const H = 180;
    const PAD = 6;
    const withPts = series.map((s) => ({ ...s, pts: byMarket[s.marketId] ?? [] }));
    const all = withPts.flatMap((s) => s.pts);
    // 0 points across every side -> nothing to draw. Otherwise draw all sides on
    // a shared axis; a side with 1 point (or a market with no time span yet) is
    // a flat baseline at its current level so it reads "live, building".
    if (all.length < 1) return null;
    const ts = all.map((p) => p.t);
    const ps = all.map((p) => p.p);
    const tMin = Math.min(...ts);
    const tMax = Math.max(...ts);
    let pMin = Math.min(...ps);
    let pMax = Math.max(...ps);
    const padY = Math.max(2, (pMax - pMin) * 0.2);
    pMin = Math.max(0, pMin - padY);
    pMax = Math.min(100, pMax + padY);
    const noSpan = tMax === tMin;
    const x = (t: number) => (noSpan ? W - PAD : PAD + ((t - tMin) / (tMax - tMin)) * (W - 2 * PAD));
    const y = (p: number) => PAD + (1 - (p - pMin) / (pMax - pMin || 1)) * (H - 2 * PAD);
    const flat = all.length < 2 || noSpan;
    const lines = withPts
      .map((s) => {
        if (s.pts.length === 0) return null;
        const last = s.pts[s.pts.length - 1];
        const single = s.pts.length === 1 || noSpan;
        const d = single
          ? `M${PAD} ${y(last.p).toFixed(1)} L${(W - PAD).toFixed(1)} ${y(last.p).toFixed(1)}`
          : s.pts.map((pt, i) => `${i ? "L" : "M"}${x(pt.t).toFixed(1)} ${y(pt.p).toFixed(1)}`).join(" ");
        return { color: s.color, d, lastX: single ? W - PAD : x(last.t), lastY: y(last.p) };
      })
      .filter((v): v is { color: string; d: string; lastX: number; lastY: number } => v !== null);
    return { W, H, lines, flat };
  }, [series, byMarket]);

  const legend = series.map((s) => {
    const pts = byMarket[s.marketId] ?? [];
    return { ...s, current: pts.length ? pts[pts.length - 1].p : null };
  });

  return (
    <div className="card price-chart">
      <div className="chart-head">
        <div className="chart-title-wrap">
          {title && <span className="chart-title">{title}</span>}
          <div className="chart-legend">
            {legend.map((l) => (
              <span key={l.marketId} className="chart-leg">
                <span className="chart-leg-dot" style={{ background: l.color }} aria-hidden="true" />
                {l.label}
                {l.current != null && (
                  <b className="chart-leg-val" style={{ color: l.color }}>
                    {Math.round(l.current)}%
                  </b>
                )}
              </span>
            ))}
          </div>
        </div>
        <div className="chart-ranges">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`chart-range${range === r.id ? " active" : ""}`}
              onClick={() => setRange(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {geom ? (
        <>
          <svg
            className="chart-svg"
            viewBox={`0 0 ${geom.W} ${geom.H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="Price history"
          >
            {geom.lines.map((ln, i) => (
              <g key={i}>
                <path
                  d={ln.d}
                  fill="none"
                  stroke={ln.color}
                  strokeWidth="2"
                  strokeDasharray={geom.flat ? "5 4" : undefined}
                  strokeOpacity={geom.flat ? 0.6 : 1}
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                />
                <circle cx={ln.lastX} cy={ln.lastY} r="3.5" fill={ln.color} vectorEffect="non-scaling-stroke" />
              </g>
            ))}
          </svg>
          {geom.flat && (
            <p className="muted chart-note">Live · history building as the market trades</p>
          )}
        </>
      ) : (
        <p className="muted chart-empty">
          {status === "error"
            ? "Price history unavailable for this market."
            : "Waiting for the first price bucket…"}
        </p>
      )}
    </div>
  );
}
