import { useMemo, useState } from "react";
import { type Socket } from "phoenix";
import {
  compactMoney,
  eventLabel,
  marketLabel,
  type MarketSummary,
  type TickerUpdate,
} from "../publicMarketData";
import { OrderBook } from "./OrderBook";
import { PriceChart, type ChartSeries } from "./PriceChart";

// Two-line money-line colors: side A (brand) vs side B (blue).
const MONEYLINE_COLORS = ["var(--brand)", "#3b82f6"];

// Prediction-market prices read best as cents (0–100¢). Convert a dollar-string
// wire value ("0.4500") to a compact "45¢".
function toCents(dollarStr: string | null | undefined): string | null {
  if (dollarStr == null) return null;
  const n = parseFloat(dollarStr);
  return Number.isFinite(n) ? `${Math.round(n * 100)}¢` : null;
}

// Product-style browser: sport / competition pills over a grid of EVENT cards
// (each with its open-market count), the way a consumer sports app presents its
// book. Clicking an event drills into that event's markets, where the market-type
// (player / game props) and stat (Hits, Points…) pills live, plus the betslip and
// order-book actions. Live `ticker` prices overlay each market card as they arrive.

interface Props {
  markets: MarketSummary[];
  tickers: Record<string, TickerUpdate>;
  socket: Socket | null;
  betslipIds: Set<string>;
  onToggle: (m: MarketSummary) => void;
  onOpenBook: (marketId: string) => void;
  loading: boolean;
  error: string | null;
}

// The money-line market for an event: the plain game market (no stat-line prop),
// preferring the shortest title (e.g. "PHI @ NYM" over "PHI @ NYM F5"). Falls
// back to the first market so an order book always has something to show.
function moneylineMarket(markets: MarketSummary[]): MarketSummary | null {
  const plain = markets
    .filter((m) => !m.statDetail)
    .sort((a, b) => (a.title?.length ?? 999) - (b.title?.length ?? 999));
  return plain[0] ?? markets[0] ?? null;
}

// The team code embedded in a game-outcome market's symbol (`…-GAME<TEAM>`, e.g.
// `-GAMEDET` -> "DET"). Null for anything that is not a plain money-line side.
function teamCode(m: MarketSummary): string | null {
  const mm = m.symbol?.match(/GAME([A-Z0-9]{2,5})$/);
  return mm ? mm[1] : null;
}

// The two money-line sides for an event — one market per team. Symbols carry the
// side (`-GAMEATL`) but also period variants (`-F5GAMEATL`, first-5 innings), so
// both would match the same team code. Dedupe by team, preferring the full-game
// market (shortest title, i.e. no "F5"), then order to match the short title
// ("ATL @ HOU" -> ATL first) so the chart draws one line per distinct side.
// Falls back to the single money-line market when a pair is not identifiable.
function moneylinePair(markets: MarketSummary[]): MarketSummary[] {
  const byTeam = new Map<string, MarketSummary>();
  const sides = markets
    .filter((m) => teamCode(m))
    .sort((a, b) => (a.title?.length ?? 999) - (b.title?.length ?? 999));
  for (const m of sides) {
    const code = teamCode(m);
    if (code && !byTeam.has(code)) byTeam.set(code, m);
  }
  const distinct = [...byTeam.values()];
  if (distinct.length >= 2) {
    const order = markets.find((m) => m.eventShortTitle)?.eventShortTitle ?? markets[0]?.shortTitle ?? "";
    return distinct
      .sort((a, b) => order.indexOf(teamCode(a) ?? "") - order.indexOf(teamCode(b) ?? ""))
      .slice(0, 2);
  }
  const single = moneylineMarket(markets);
  return single ? [single] : [];
}

const ALL = "All";
const MAX_CARDS = 90;

type PropKind = "all" | "player" | "game" | "other";

interface EventGroup {
  eventId: string;
  title: string;
  sport: string | null;
  competition: string | null;
  markets: MarketSummary[];
}

// A stat-line prop has a statDetail; a player prop additionally names a player.
function marketKind(m: MarketSummary): "player" | "game" | "other" {
  if (m.statDetail?.player) return "player";
  if (m.statDetail) return "game";
  return "other";
}

// A readable player-prop label ("Max Muncy · Hits 0.5") when it is one.
function propLabel(m: MarketSummary): string | null {
  const sd = m.statDetail;
  if (!sd?.player) return null;
  const stat = sd.statDisplayName ?? sd.stat ?? "";
  const line = sd.line != null ? ` ${sd.line}` : "";
  return `${sd.player}${stat ? ` · ${stat}` : ""}${line}`;
}

function distinct(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v && v.trim() !== ""))].sort();
}

export function MarketBrowser({
  markets,
  tickers,
  socket,
  betslipIds,
  onToggle,
  onOpenBook,
  loading,
  error,
}: Props) {
  const [sport, setSport] = useState<string>(ALL);
  const [competition, setCompetition] = useState<string>(ALL);
  const [openEventId, setOpenEventId] = useState<string | null>(null);
  const [propKind, setPropKind] = useState<PropKind>("all");
  const [statType, setStatType] = useState<string>(ALL);

  const sports = useMemo(() => distinct(markets.map((m) => m.sport)), [markets]);
  const competitions = useMemo(
    () =>
      distinct(
        markets.filter((m) => sport === ALL || m.sport === sport).map((m) => m.competition),
      ),
    [markets, sport],
  );

  const scoped = useMemo(
    () =>
      markets.filter(
        (m) =>
          (sport === ALL || m.sport === sport) &&
          (competition === ALL || m.competition === competition),
      ),
    [markets, sport, competition],
  );

  // Group the scoped markets into events, most markets first.
  const events = useMemo(() => {
    const map = new Map<string, EventGroup>();
    for (const m of scoped) {
      const id = m.eventId ?? m.eventTitle ?? "ungrouped";
      let g = map.get(id);
      if (!g) {
        g = {
          eventId: id,
          title: m.eventTitle ?? m.eventShortTitle ?? "Event",
          sport: m.sport,
          competition: m.competition,
          markets: [],
        };
        map.set(id, g);
      }
      g.markets.push(m);
    }
    return [...map.values()].sort((a, b) => b.markets.length - a.markets.length);
  }, [scoped]);

  const openEvent = openEventId ? events.find((e) => e.eventId === openEventId) ?? null : null;
  const eventMarkets = openEvent?.markets ?? [];

  const kindCounts = useMemo(
    () => ({
      player: eventMarkets.filter((m) => marketKind(m) === "player").length,
      game: eventMarkets.filter((m) => marketKind(m) === "game").length,
      other: eventMarkets.filter((m) => marketKind(m) === "other").length,
    }),
    [eventMarkets],
  );
  const statOptions = useMemo(
    () =>
      propKind === "player"
        ? distinct(
            eventMarkets
              .filter((m) => marketKind(m) === "player")
              .map((m) => m.statDetail?.statDisplayName ?? null),
          )
        : [],
    [eventMarkets, propKind],
  );
  const eventFiltered = useMemo(
    () =>
      eventMarkets.filter(
        (m) =>
          (propKind === "all" || marketKind(m) === propKind) &&
          (statType === ALL || m.statDetail?.statDisplayName === statType),
      ),
    [eventMarkets, propKind, statType],
  );
  const moneyPair = useMemo(() => moneylinePair(eventMarkets), [eventMarkets]);
  const chartSeries = useMemo<ChartSeries[]>(
    () =>
      moneyPair.map((m, i) => ({
        marketId: m.marketId,
        label: teamCode(m) ?? marketLabel(m),
        color: MONEYLINE_COLORS[i % MONEYLINE_COLORS.length],
      })),
    [moneyPair],
  );

  function pickSport(s: string) {
    setSport(s);
    setCompetition(ALL);
    closeEvent();
  }
  function pickCompetition(c: string) {
    setCompetition(c);
    closeEvent();
  }
  function openEventDetail(id: string) {
    setOpenEventId(id);
    setPropKind("all");
    setStatType(ALL);
  }
  function closeEvent() {
    setOpenEventId(null);
    setPropKind("all");
    setStatType(ALL);
  }

  return (
    <div className="browser">
      {/* Breadcrumbs: where we are as we drill down. */}
      <nav className="crumbs" aria-label="Breadcrumb">
        <button
          type="button"
          className="crumb"
          onClick={() => { pickSport(ALL); }}
          disabled={sport === ALL && !openEvent}
        >
          All events
        </button>
        {sport !== ALL && (
          <>
            <span className="crumb-sep">/</span>
            <button
              type="button"
              className="crumb"
              onClick={() => { setCompetition(ALL); closeEvent(); }}
              disabled={competition === ALL && !openEvent}
            >
              {sport}
            </button>
          </>
        )}
        {competition !== ALL && (
          <>
            <span className="crumb-sep">/</span>
            <button type="button" className="crumb" onClick={closeEvent} disabled={!openEvent}>
              {competition}
            </button>
          </>
        )}
        {openEvent && (
          <>
            <span className="crumb-sep">/</span>
            <span className="crumb crumb-current">{openEvent.title}</span>
          </>
        )}
      </nav>

      {/* Sport + competition pills (event grid only). */}
      {!openEvent && (
        <>
          <div className="pill-row" role="tablist" aria-label="Sport">
            <Pill label={ALL} active={sport === ALL} onClick={() => pickSport(ALL)} count={markets.length} />
            {sports.map((s) => (
              <Pill
                key={s}
                label={s}
                active={sport === s}
                onClick={() => pickSport(s)}
                count={markets.filter((m) => m.sport === s).length}
              />
            ))}
          </div>

          {competitions.length > 1 && (
            <div className="pill-row pill-row-sub" role="tablist" aria-label="Competition">
              <Pill label={ALL} active={competition === ALL} onClick={() => pickCompetition(ALL)} />
              {competitions.map((c) => (
                <Pill key={c} label={c} active={competition === c} onClick={() => pickCompetition(c)} />
              ))}
            </div>
          )}
        </>
      )}

      {error ? (
        <p className="error">Could not load markets: {error}</p>
      ) : loading ? (
        <div className="card-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="market-card skeleton" />
          ))}
        </div>
      ) : !openEvent ? (
        // ---- Event grid ----
        events.length === 0 ? (
          <p className="muted browser-empty">No open events in this filter.</p>
        ) : (
          <>
            <div className="card-grid">
              {events.slice(0, MAX_CARDS).map((e) => (
                <EventCard key={e.eventId} event={e} onOpen={() => openEventDetail(e.eventId)} />
              ))}
            </div>
            {events.length > MAX_CARDS && (
              <p className="muted list-more">
                Showing {MAX_CARDS} of {events.length} events. Use the filters to narrow.
              </p>
            )}
          </>
        )
      ) : (
        // ---- Event detail: its markets, with prop/stat pills ----
        <div className="event-detail">
          <div className="event-detail-head">
            <h3>{openEvent.title}</h3>
            <span className="muted">
              {openEvent.sport}
              {openEvent.competition ? ` · ${openEvent.competition}` : ""} · {eventMarkets.length}{" "}
              markets
            </span>
          </div>

          {/* Market-type / stat filters sit above the featured graph. */}
          {(kindCounts.player > 0 || kindCounts.game > 0) && (
            <div className="pill-row pill-row-sub" role="tablist" aria-label="Market type">
              <Pill label="All types" active={propKind === "all"} onClick={() => { setPropKind("all"); setStatType(ALL); }} />
              {kindCounts.player > 0 && (
                <Pill label="Player props" active={propKind === "player"} onClick={() => { setPropKind("player"); setStatType(ALL); }} count={kindCounts.player} />
              )}
              {kindCounts.game > 0 && (
                <Pill label="Game props" active={propKind === "game"} onClick={() => { setPropKind("game"); setStatType(ALL); }} count={kindCounts.game} />
              )}
              {kindCounts.other > 0 && (
                <Pill label="Other" active={propKind === "other"} onClick={() => { setPropKind("other"); setStatType(ALL); }} count={kindCounts.other} />
              )}
            </div>
          )}

          {propKind === "player" && statOptions.length > 1 && (
            <div className="pill-row pill-row-sub" role="tablist" aria-label="Stat">
              <Pill label="All stats" active={statType === ALL} onClick={() => setStatType(ALL)} />
              {statOptions.map((st) => (
                <Pill
                  key={st}
                  label={st}
                  active={statType === st}
                  onClick={() => setStatType(st)}
                  count={
                    eventMarkets.filter(
                      (m) => marketKind(m) === "player" && m.statDetail?.statDisplayName === st,
                    ).length
                  }
                />
              ))}
            </div>
          )}

          {/* Featured money line: two-line price chart (one per side) + the
              primary side's order book, before the full market list. */}
          {moneyPair.length > 0 && (
            <div className="card event-moneyline">
              <div className="moneyline-head">
                <span className="moneyline-title">{marketLabel(moneyPair[0])}</span>
                <span className="tag">Money line</span>
              </div>
              <PriceChart
                key={`chart-${chartSeries.map((s) => s.marketId).join("-")}`}
                socket={socket}
                series={chartSeries}
              />
              <div className="moneyline-book">
                {chartSeries[0] && (
                  <div className="moneyline-book-head" style={{ color: chartSeries[0].color }}>
                    {chartSeries[0].label} order book
                  </div>
                )}
                <OrderBook key={`ml-${moneyPair[0].marketId}`} socket={socket} marketId={moneyPair[0].marketId} />
              </div>
            </div>
          )}

          <div className="card-grid">
            {eventFiltered.slice(0, MAX_CARDS).map((m) => (
              <MarketCard
                key={m.marketId}
                market={m}
                live={tickers[m.marketId]}
                selected={betslipIds.has(m.marketId)}
                onSelect={() => onToggle(m)}
                onOpenBook={() => onOpenBook(m.marketId)}
              />
            ))}
          </div>
          {eventFiltered.length > MAX_CARDS && (
            <p className="muted list-more">
              Showing {MAX_CARDS} of {eventFiltered.length}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Pill({
  label,
  active,
  onClick,
  count,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  count?: number;
}) {
  return (
    <button type="button" className={`pill${active ? " pill-active" : ""}`} onClick={onClick}>
      {label}
      {count != null && <span className="pill-count">{count}</span>}
    </button>
  );
}

function EventCard({ event, onOpen }: { event: EventGroup; onOpen: () => void }) {
  return (
    <button type="button" className="market-card event-card" onClick={onOpen}>
      <div className="market-card-tags">
        {event.sport && <span className="tag tag-sport">{event.sport}</span>}
        {event.competition && <span className="tag">{event.competition}</span>}
      </div>
      <div className="market-card-title">{event.title}</div>
      <div className="market-card-foot">
        <span className="event-count">{event.markets.length} markets</span>
        <span className="market-card-cta" aria-hidden="true">
          View →
        </span>
      </div>
    </button>
  );
}

function MarketCard({
  market,
  live,
  selected,
  onSelect,
  onOpenBook,
}: {
  market: MarketSummary;
  live: TickerUpdate | undefined;
  selected: boolean;
  onSelect: () => void;
  onOpenBook: () => void;
}) {
  // Market price from the book (best bid / ask via the live ticker), in cents;
  // fall back to the last traded price from the catalog when the ticker has not
  // arrived (lastTradedPrice is already in cents).
  const bid = toCents(live?.best_bid);
  const ask = toCents(live?.best_offer);
  const last = live?.last_traded_price
    ? toCents(live.last_traded_price)
    : market.lastTradedPrice != null
      ? `${Math.round(market.lastTradedPrice)}¢`
      : "—";
  const vol = live?.total_volume ? compactMoney(live.total_volume) : null;

  return (
    <div className="market-card-wrap">
      <button
        type="button"
        className={`market-card${selected ? " selected" : ""}`}
        onClick={onSelect}
        aria-pressed={selected}
      >
        <div className="market-card-tags">
          {market.statDetail?.player ? (
            <span className="tag tag-prop">Player prop</span>
          ) : (
            market.statDetail && <span className="tag">Game prop</span>
          )}
        </div>
        <div className="market-card-title">{propLabel(market) ?? marketLabel(market)}</div>
        <div className="market-card-event">
          {propLabel(market) ? marketLabel(market) : eventLabel(market)}
        </div>
        <div className="market-card-foot">
          {bid && ask ? (
            <span className="price-chip price-live">
              <span className="price-chip-label">Bid/Ask</span>
              <span className="price-chip-value">{bid} / {ask}</span>
            </span>
          ) : (
            <span className="price-chip">
              <span className="price-chip-label">Last</span>
              <span className="price-chip-value">{last}</span>
            </span>
          )}
          {vol && <span className="market-card-vol">Vol {vol}</span>}
          <span className="market-card-cta" aria-hidden="true">
            {selected ? "✓ In betslip" : "+ Betslip"}
          </span>
        </div>
      </button>
      <button
        type="button"
        className="card-book-btn"
        onClick={onOpenBook}
        title="Order book"
        aria-label="Order book"
      >
        ▤
      </button>
    </div>
  );
}
