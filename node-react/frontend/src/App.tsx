import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, BACKEND, openStxPopup, type MeState, type PublicApp } from "./api";
import { marketLabel, setStxUrl, stxUrl, type MarketBrief, type MarketSummary } from "./publicMarketData";
import { IsvLogo } from "./components/IsvLogo";
import { SignIn } from "./components/SignIn";
import { Wallets } from "./components/Wallets";
import { AccountMenu } from "./components/AccountMenu";
import { LiveFeed } from "./components/LiveFeed";
import { Betslip, type BetslipLeg } from "./components/Betslip";
import { ActivityPanel } from "./components/ActivityPanel";
import { MyActivity, type ActivityTab } from "./components/MyActivity";
import { MarketData } from "./components/MarketData";
import { PoweredByStx } from "./components/PoweredByStx";
import { SourceFootLink, SourceIconLink } from "./components/SourceLink";
import { LiveAccountProvider, useLiveAccountStream } from "./liveAccount";
import { initAnalytics, track, trackPage } from "./analytics";
import { ConsentBanner } from "./components/ConsentBanner";

const THEME_KEY = "stx_isv_theme";

// Virtual paths for page views (the app changes views without changing the URL).
const VIEW_PATH: Record<"home" | "api" | ActivityTab, string> = {
  home: "/",
  orders: "/orders",
  trades: "/trades",
  settlements: "/settlements",
  api: "/api-calls",
};

const NAV_LABEL: Record<ActivityTab, string> = {
  orders: "My orders",
  trades: "My trades",
  settlements: "Settlements",
};

// Readable messages for the ?error codes the backend redirects back with.
const ERROR_MESSAGES: Record<string, string> = {
  not_signed_in: "Sign in to the app before linking your STX account.",
  unknown_app: "Unknown app profile.",
  invalid_state: "The linking request expired or was replayed. Try again.",
  missing_code_or_state: "STX did not return an authorization code. Try again.",
  token_exchange_failed: "STX rejected the token exchange. Check the client credentials.",
  link_target_gone: "The account to link to was gone by the time STX redirected back.",
};

// Top-level app: Sideline, a fictional sports app, connecting to STX.
// Main column: the public, credential-free live markets with scores. Side
// column: the member journey (sign in, dual wallet, link STX) and the betslip,
// which appears when a market is tapped.
export function App() {
  const [profile, setProfile] = useState<PublicApp | null>(null);
  const [me, setMe] = useState<MeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [theme, setTheme] = useState<"system" | "dark" | "light">(() => {
    const v = safeLocalGet(THEME_KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  });
  // Betslip: markets multi-selected from the cards, placed together as a batch.
  const [betslip, setBetslip] = useState<BetslipLeg[]>([]);
  const betslipIds = useMemo(() => new Set(betslip.map((l) => l.marketId)), [betslip]);
  // Live event status (score, clock) by event id, from the market feed.
  const [briefs, setBriefs] = useState<Record<string, MarketBrief>>({});
  const onBrief = useCallback((eventId: string, b: MarketBrief) => {
    setBriefs((cur) => ({ ...cur, [eventId]: b }));
  }, []);
  const [view, setView] = useState<"home" | "api" | ActivityTab>("home");

  function toggleBetslip(m: MarketSummary) {
    setBetslip((cur) => {
      if (cur.some((l) => l.marketId === m.marketId)) {
        return cur.filter((l) => l.marketId !== m.marketId);
      }
      const priceCents = m.lastTradedPrice != null ? String(Math.round(m.lastTradedPrice)) : "";
      return [
        ...cur,
        {
          marketId: m.marketId,
          label: marketLabel(m),
          action: "buy",
          orderType: "limit",
          price: priceCents,
          quantity: "",
          maxPrice: m.maxPrice,
          market: m,
        },
      ];
    });
  }

  // The betslip opens on the first tapped market. On a narrow screen it sits
  // below the markets, so bring it into view.
  const hadLegs = useRef(false);
  useEffect(() => {
    const has = betslip.length > 0;
    if (has && !hadLegs.current && window.matchMedia("(max-width: 900px)").matches) {
      requestAnimationFrame(() => document.getElementById("betslip")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
    hadLegs.current = has;
  }, [betslip.length]);
  // Bumped after any state change so child panels refetch.
  const [refreshKey, setRefreshKey] = useState(0);

  const bump = () => setRefreshKey((k) => k + 1);

  // Load `me` for the active app.
  async function reloadMe(verify = false) {
    try {
      setMe(await api.me(verify));
    } catch {
      setMe(null);
    }
  }

  // Before the betslip offers "Place", make sure the STX link still works: a
  // grant revoked at STX (or refused on refresh) must show the link call to
  // action, not a Place button that fails. Checked when the slip opens, when an
  // order comes back "not linked", and when the live feed ends.
  const [checkingLink, setCheckingLink] = useState(false);
  async function verifyLink() {
    setCheckingLink(true);
    try {
      await reloadMe(true);
    } finally {
      setCheckingLink(false);
    }
  }

  // Optional analytics (see analytics.ts): on only when the backend sends a
  // measurement id; the footer link reopens the consent choice.
  const [analyticsOn, setAnalyticsOn] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  // A virtual page view per view; the API calls page is also an event.
  useEffect(() => {
    trackPage(VIEW_PATH[view], view === "home" ? "Markets" : view === "api" ? "API calls" : NAV_LABEL[view]);
    if (view === "api") track("api_calls_view");
  }, [view]);

  // The logo goes home: the markets list, no open game, an empty betslip.
  const [homeKey, setHomeKey] = useState(0);
  function goHome() {
    setView("home");
    setBetslip([]);
    setHomeKey((k) => k + 1);
    window.scrollTo({ top: 0 });
  }

  // Boot: read the OAuth redirect flags, load the app profile, then the
  // member's state.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get("error");
    const linked = params.get("linked");
    if (err) setBanner({ kind: "error", text: ERROR_MESSAGES[err] ?? `OAuth error: ${err}` });
    else if (linked) setBanner({ kind: "ok", text: "STX account linked." });
    // Drop only the app's own flags; anything else (utm_* campaign tags) stays
    // for the landing page view.
    if (params.has("error") || params.has("linked") || params.has("app")) {
      for (const k of ["error", "linked", "app"]) params.delete(k);
      const rest = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (rest ? `?${rest}` : ""));
    }

    (async () => {
      try {
        const res = await api.app();
        setProfile(res.app);
        setStxUrl(res.stxPublicUrl);
        initAnalytics(res.gaMeasurementId);
        setAnalyticsOn(Boolean(res.gaMeasurementId));
      } catch {
        // app() failing means the backend is unreachable; leave the banner.
      }
      await reloadMe();
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function afterAuthChange() {
    await reloadMe();
    bump();
  }

  // Receive the linking result from the OAuth popup (/callback relays it via
  // postMessage, then closes itself: see startLink). Only messages from this
  // app's own origin or its backend's are trusted: deployed they are the same
  // origin; in local development the popup is served by the backend (:8787).
  useEffect(() => {
    const trusted = [window.location.origin, new URL(BACKEND, window.location.href).origin];
    function onLinkMessage(e: MessageEvent) {
      if (!trusted.includes(e.origin)) return;
      const data = e.data as { type?: string; status?: string; error?: string } | null;
      if (!data || data.type !== "stx-link") return;
      if (data.status === "linked") {
        track("link_success");
        setBanner({ kind: "ok", text: "STX account linked." });
      } else if (data.error) {
        track("link_error", { error: String(data.error).slice(0, 40) });
        setBanner({
          kind: "error",
          text: ERROR_MESSAGES[data.error] ?? `OAuth error: ${data.error}`,
        });
      }
      void afterAuthChange();
    }
    window.addEventListener("message", onLinkMessage);
    return () => window.removeEventListener("message", onLinkMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Banners are transient confirmations ("STX account linked."), not persistent
  // state: auto-dismiss so they don't linger once the member is connected.
  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 4000);
    return () => clearTimeout(t);
  }, [banner]);

  // Theme: system (default) / light / dark, flipped from the header and
  // persisted per browser. `system` resolves to the OS preference and tracks it
  // live; light/dark pin an explicit choice.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = theme === "system" ? (mq.matches ? "dark" : "light") : theme;
      document.documentElement.setAttribute("data-theme", resolved);
    };
    apply();
    safeLocalSet(THEME_KEY, theme);
    if (theme !== "system") return;
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  async function handleSignout() {
    await api.signout();
    await afterAuthChange();
  }

  const app = me?.app ?? profile;
  const linked = me?.link.connected ?? false;
  // The member's live STX account (balance, open orders, fills, positions),
  // one SSE stream for the whole app while signed in and linked. With it open,
  // trading refetches nothing: the panels update from the stream. Without it
  // (the feed failed), placements and cancels fall back to a refetch.
  const liveAccount = useLiveAccountStream(Boolean(me?.user) && linked);
  const afterTrade = liveAccount.live ? () => {} : bump;

  // Opening the betslip (first market tapped) while linked checks the link.
  const slipOpen = betslip.length > 0;
  useEffect(() => {
    if (slipOpen && linked) void verifyLink();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slipOpen]);
  // The live feed ended (the grant died): re-read the link.
  useEffect(() => {
    if (liveAccount.failed && linked) void verifyLink();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveAccount.failed]);
  const brandColor = app?.brandColor ?? "#3d8bff";
  const appName = app?.name ?? "Sideline";

  return (
    <LiveAccountProvider value={liveAccount}>
    <div className="app-shell" style={{ ["--brand" as string]: brandColor } as React.CSSProperties}>
      <header className="topbar">
        <a
          className="topbar-brand"
          href="/"
          id="home-link"
          aria-label={`${appName} home`}
          onClick={(e) => {
            e.preventDefault();
            goHome();
          }}
        >
          <IsvLogo appId={app?.id} name={appName} brandColor={brandColor} />
        </a>
        {me?.user && (
          <nav className="topbar-nav">
            <button
              type="button"
              className={`nav-item${view === "home" ? " active" : ""}`}
              onClick={() => setView("home")}
            >
              Home
            </button>
            {linked &&
              (["orders", "trades", "settlements"] as ActivityTab[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  className={`nav-item${view === v ? " active" : ""}`}
                  onClick={() => setView(v)}
                >
                  {NAV_LABEL[v]}
                </button>
              ))}
            <button
              type="button"
              className={`nav-item${view === "api" ? " active" : ""}`}
              onClick={() => setView("api")}
            >
              API calls
            </button>
          </nav>
        )}
        <div className="topbar-right">
          {me?.user && linked && (
            <button
              type="button"
              className="header-deposit"
              aria-label="Deposit at STX"
              onClick={() => {
                track("deposit_click");
                openStxPopup(`${stxUrl()}/player/deposit_funds`, "stx_deposit", { w: 540, h: 780 });
              }}
            >
              <span aria-hidden="true">+</span>
              <span className="deposit-text">Deposit</span>
            </button>
          )}
          <SourceIconLink />
          <button
            type="button"
            className="theme-toggle"
            onClick={() =>
              setTheme((t) => (t === "system" ? "light" : t === "light" ? "dark" : "system"))
            }
            title={`Theme: ${theme} (click to change)`}
            aria-label={`Theme: ${theme}. Click to change.`}
          >
            {theme === "light" ? "☀" : theme === "dark" ? "☾" : "◐"}
          </button>
          {me?.user && app && (
            <AccountMenu
              app={app}
              user={me.user}
              link={me.link}
              onChanged={afterAuthChange}
              onSignOut={handleSignout}
            />
          )}
        </div>
      </header>

      {banner && <div className={`banner banner-${banner.kind}`}>{banner.text}</div>}

      {view === "home" ? (
        <div className="layout">
          {/* Browse: public STX markets + live order book (no credential). */}
          <main className="market-col">
            <div className="section-head">
              <h2>Markets</h2>
            </div>
            <MarketData
              betslipIds={betslipIds}
              onToggleBetslip={toggleBetslip}
              briefs={briefs}
              onBrief={onBrief}
              homeKey={homeKey}
            />
          </main>

          {/* Trade + account: the ISV member journey, on the right like a real book. */}
          <aside className="trade-col">
            {loading || !app ? (
              <div className="card">
                <p className="muted">Loading…</p>
              </div>
            ) : (
              <>
                {!me?.user && <SignIn app={app} onSignedIn={afterAuthChange} />}
                {me?.user && <Wallets app={app} linked={linked} refreshKey={refreshKey} />}
                {/* Appears when a market is tapped; unlinked, it carries the
                    link call to action where the order would go. */}
                <Betslip
                  legs={betslip}
                  onChange={setBetslip}
                  onPlaced={afterTrade}
                  linked={linked}
                  signedIn={Boolean(me?.user)}
                  appName={appName}
                  briefs={briefs}
                  checkingLink={checkingLink}
                  onUnlinked={verifyLink}
                />
                {me?.user && linked && <LiveFeed />}
              </>
            )}
          </aside>
        </div>
      ) : view === "api" ? (
        <section className="page">
          <div className="section-head">
            <h2>API calls</h2>
            <span className="muted">Every request this app's backend made to STX, newest first.</span>
          </div>
          <ActivityPanel refreshKey={refreshKey} embedded />
        </section>
      ) : me?.user && linked ? (
        <section className="page">
          <div className="section-head">
            <h2>{NAV_LABEL[view]}</h2>
          </div>
          <MyActivity refreshKey={refreshKey + liveAccount.resyncs} onChanged={afterTrade} activeTab={view} />
        </section>
      ) : null}

      <footer className="app-foot">
        <div className="foot-text">
          <p className="fiction-note" id="fiction-note">
            Sideline is a demo app built on the STX API. Not a real product.
          </p>
          <p className="muted">Markets, scores, orders and balances are real STX preview data.</p>
          {analyticsOn && (
            <p className="muted analytics-note">
              Anonymous usage statistics with your consent.{" "}
              <button type="button" className="link" onClick={() => setConsentOpen(true)}>
                Usage statistics
              </button>
            </p>
          )}
        </div>
        <div className="foot-links">
          <SourceFootLink />
          <PoweredByStx />
        </div>
      </footer>
      <ConsentBanner reopen={consentOpen} onClose={() => setConsentOpen(false)} />
    </div>
    </LiveAccountProvider>
  );
}

// localStorage is best-effort; a private window or blocked storage must not
// break the app.
function safeLocalGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeLocalSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}
