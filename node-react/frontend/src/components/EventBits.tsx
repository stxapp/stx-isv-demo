import { useState } from "react";
import {
  isLive,
  splitBrief,
  sportIconUrl,
  startLabel,
  teams,
  type MarketBrief,
  type MarketSummary,
  type Participant,
} from "../publicMarketData";

// The pieces that make an event read like a sports app: the league's sport icon
// (served by the exchange itself), the two teams, and the live score or start
// time. The exchange serves sport icons but no team or league logos, so a team is
// shown as a badge of its abbreviation in a colour derived from it: stable,
// distinct per team, and never an image from a third party.

// The exchange's sport icon, on a small tile. Hidden if the image fails to load.
export function SportIcon({ sport, size = 18 }: { sport: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <span className="sport-icon" style={{ width: size + 8, height: size + 8 }} title={sport ?? undefined}>
      <img src={sportIconUrl(sport)} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(true)} />
    </span>
  );
}

// A stable hue per team code, so CHC is always the same colour.
function hueOf(code: string): number {
  let h = 0;
  for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export function TeamBadge({ team, size = "md" }: { team: Participant; size?: "sm" | "md" }) {
  const code = (team.abbreviation ?? team.shortName ?? team.name ?? "?").slice(0, 4).toUpperCase();
  return (
    <span
      className={`team-badge team-badge-${size}`}
      style={{ ["--team-hue" as string]: String(hueOf(code)) } as React.CSSProperties}
      title={team.name ?? code}
      aria-hidden="true"
    >
      {code}
    </span>
  );
}

// "CHC @ BOS" as badges and names, away above home. `score` splits a live brief
// ("CHC 3 - 4 BOS") into per-team numbers when it has that shape.
export function Matchup({ market, brief, compact = false }: { market: MarketSummary; brief?: MarketBrief; compact?: boolean }) {
  const pair = teams(market);
  if (pair.length < 2) return null;
  const scores = scoresFrom(brief?.event_brief, pair);
  return (
    <div className={`matchup${compact ? " matchup-compact" : ""}`}>
      {pair.map((t, i) => (
        <div className="matchup-row" key={`${t.role}-${t.abbreviation ?? i}`}>
          <TeamBadge team={t} size={compact ? "sm" : "md"} />
          <span className="matchup-name">{compact ? (t.shortName ?? t.name) : t.name}</span>
          {scores && <span className="matchup-score">{scores[i]}</span>}
        </div>
      ))}
    </div>
  );
}

// One line: "CHC @ BOS" as badges, with the live score after each when there is
// one. The badges are decorative, so the full names are in hidden text for
// screen readers and in the tooltip.
export function MatchupInline({ market, brief }: { market: MarketSummary; brief?: MarketBrief }) {
  const pair = teams(market);
  if (pair.length < 2) return null;
  const scores = scoresFrom(brief?.event_brief, pair);
  const names = pair.map((t, i) => `${t.name ?? t.abbreviation ?? "?"}${scores ? ` ${scores[i]}` : ""}`).join(" at ");
  return (
    <span className="matchup-inline" title={names}>
      {pair.map((t, i) => (
        <span className="matchup-inline-team" key={`${t.role}-${t.abbreviation ?? i}`}>
          {i > 0 && <span className="matchup-at" aria-hidden="true">@</span>}
          <TeamBadge team={t} size="sm" />
          {scores && <span className="matchup-inline-score" aria-hidden="true">{scores[i]}</span>}
        </span>
      ))}
      <span className="visually-hidden">{names}</span>
    </span>
  );
}

// Per-team scores from "AWAY 3 - 4 HOME", in [away, home] order, or null.
function scoresFrom(brief: string | null | undefined, pair: Participant[]): [string, string] | null {
  const score = splitBrief(brief)?.score;
  const m = score?.match(/^(\S+)\s+(\d+)\s*-\s*(\d+)\s+(\S+)$/);
  if (!m) return null;
  const [, a, as, hs, h] = m;
  const away = pair[0]?.abbreviation?.toUpperCase();
  const home = pair[1]?.abbreviation?.toUpperCase();
  if (a!.toUpperCase() === away && h!.toUpperCase() === home) return [as!, hs!];
  if (a!.toUpperCase() === home && h!.toUpperCase() === away) return [hs!, as!];
  return null;
}

// LIVE with the clock ("Bottom 8th"), or the start time for a scheduled event.
export function EventStatus({ market, brief }: { market: MarketSummary; brief?: MarketBrief }) {
  const status = brief?.event_status ?? market.eventStatus;
  if (isLive(status)) {
    const parts = splitBrief(brief?.event_brief);
    return (
      <span className="event-status event-status-live">
        <span className="live-beacon" aria-hidden="true" />
        Live
        {parts?.clock && <span className="event-clock">{parts.clock}</span>}
      </span>
    );
  }
  if (status === "completed" || status === "final" || /final/i.test(brief?.event_brief ?? "")) {
    return <span className="event-status">{brief?.event_brief ?? "Final"}</span>;
  }
  const start = startLabel(market.eventStart);
  return start ? <span className="event-status">{start}</span> : null;
}
