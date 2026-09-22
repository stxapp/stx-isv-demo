import { useEffect, useState } from "react";
import { api, openStxPopup, setActiveApp, BACKEND_ORIGIN, type MeState, type PublicApp } from "./api";
import { STX_HTTP_URL, marketLabel, type MarketSummary } from "./publicMarketData";
import { SignIn } from "./components/SignIn";
import { Wallets } from "./components/Wallets";
import { Connection } from "./components/Connection";
import { LiveFeed } from "./components/LiveFeed";
import { Betslip, type BetslipLeg } from "./components/Betslip";
import { ActivityPanel } from "./components/ActivityPanel";
import { MyActivity, type ActivityTab } from "./components/MyActivity";
import { MarketData } from "./components/MarketData";
import { PoweredByStx } from "./components/PoweredByStx";

const STORAGE_KEY = "stx_isv_active_app";
const THEME_KEY = "stx_isv_theme";

const NAV_LABEL: Record<ActivityTab, string> = {
  orders: "My orders",
  trades: "My trades",
  settlements: "Settlements",
};

// Readable messages for the ?error codes the backend redirects back with.
const ERROR_MESSAGES: Record<string, string> = {
  not_signed_in: "Sign in to the app before linking your STX account.",
  unknown_app: "Unknown app profile.",
  invalid_state: "The linking request expired or was replayed — try again.",
  missing_code_or_state: "STX did not return an authorization code — try again.",
  token_exchange_failed: "STX rejected the token exchange — check the client credentials.",
  link_target_gone: "The account to link to was gone by the time STX redirected back.",
};

// Top-level app. Presents as the ISV app (Heater) connecting to STX.
// Left column: the ISV member journey — sign in, dual wallet, link STX, trade.
// Right column: the public, credential-free live market-data feed.
export function App() {
  const [apps, setApps] = useState<PublicApp[]>([]);
  const [activeId, setActiveId] = useState<string>("heater");
  const [me, setMe] = useState<MeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [theme, setTheme] = useState<"system" | "dark" | "light">(() => {
    const v = safeLocalGet(THEME_KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  });
  // Betslip: markets multi-selected from the cards, placed together as a batch.
  const [betslip, setBetslip] = useState<BetslipLeg[]>([]);
  const betslipIds = new Set(betslip.map((l) => l.marketId));
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
        },
      ];
    });
  }
  // Bumped after any state change so child panels refetch.
  const [refreshKey, setRefreshKey] = useState(0);

  const bump = () => setRefreshKey((k) => k + 1);

  // Load `me` for the active app.
  async function reloadMe() {
    try {
      setMe(await api.me());
    } catch {
      setMe(null);
    }
  }

  // Boot: read the OAuth redirect flags, load app profiles, pick the active
  // app, then load its state.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get("error");
    const linked = params.get("linked");
    const appParam = params.get("app");
    if (err) setBanner({ kind: "error", text: ERROR_MESSAGES[err] ?? `OAuth error: ${err}` });
    else if (linked) setBanner({ kind: "ok", text: "STX account linked." });
    if (params.has("error") || params.has("linked") || params.has("app")) {
      window.history.replaceState({}, "", window.location.pathname);
    }

    (async () => {
      let list: PublicApp[] = [];
      try {
        const res = await api.apps();
        list = res.apps;
        setApps(list);
      } catch {
        // apps() failing means the backend is unreachable; leave the banner.
      }
      // Prefer the app from the callback, then the stored choice, then default.
      const stored = safeLocalGet(STORAGE_KEY);
      const wanted = appParam || stored || list.find((a) => a.isDefault)?.id || "heater";
      const chosen = list.find((a) => a.id === wanted && a.enabled)?.id ?? list.find((a) => a.enabled)?.id ?? "heater";
      applyActiveApp(chosen);
      await reloadMe();
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyActiveApp(id: string) {
    setActiveApp(id); // module-level: every /api call now carries ?app=id
    setActiveId(id);
    safeLocalSet(STORAGE_KEY, id);
  }

  async function afterAuthChange() {
    await reloadMe();
    bump();
  }

  // Receive the linking result from the OAuth popup (/callback relays it via
  // postMessage, then closes itself — see startLink). The popup runs on the
  // backend origin, so trust that alongside this window's own origin (they are
  // the same in a single-origin deploy, and differ in split dev). The message
  // carries only link status, never a token.
  useEffect(() => {
    function onLinkMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin && e.origin !== BACKEND_ORIGIN) return;
      const data = e.data as { type?: string; status?: string; error?: string } | null;
      if (!data || data.type !== "stx-link") return;
      if (data.status === "linked") {
        setBanner({ kind: "ok", text: "STX account linked." });
      } else if (data.error) {
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
  // state — auto-dismiss so they don't linger once the member is connected.
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

  const app = me?.app ?? apps.find((a) => a.id === activeId) ?? null;
  const linked = me?.link.connected ?? false;
  const brandColor = app?.brandColor ?? "#ff5a1f";
  const appName = app?.name ?? "Heater";

  return (
    <div className="app-shell" style={{ ["--brand" as string]: brandColor } as React.CSSProperties}>
      <header className="topbar">
        <div className="topbar-brand">
          <span className="isv-mark" style={{ background: brandColor }} aria-hidden="true">
            {(appName[0] || "?").toUpperCase()}
          </span>
          <span className="isv-name">{appName}</span>
        </div>
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
          {me?.user && app && (
            <Connection app={app} link={me.link} onChanged={afterAuthChange} />
          )}
          {me?.user && linked && (
            <button
              type="button"
              className="header-deposit"
              onClick={() =>
                openStxPopup(`${STX_HTTP_URL}/player/deposit_funds`, "stx_deposit", { w: 540, h: 780 })
              }
            >
              <span aria-hidden="true">+</span> Deposit
            </button>
          )}
          {me?.user && (
            <div className="whoami">
              <span className="whoami-name">{me.user.name}</span>
              <button className="link" onClick={handleSignout}>
                Sign out
              </button>
            </div>
          )}
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
        </div>
      </header>

      {banner && <div className={`banner banner-${banner.kind}`}>{banner.text}</div>}

      {view === "home" ? (
        <div className="layout">
          {/* Browse: public STX markets + live order book (no credential). */}
          <main className="market-col">
            <div className="section-head">
              <h2>Markets</h2>
              <span className="muted">Live prices and depth from the STX Exchange.</span>
            </div>
            <MarketData betslipIds={betslipIds} onToggleBetslip={toggleBetslip} />
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
                {/* Always visible so a slip built while signed out shows a clear
                    sign-in / link prompt rather than vanishing. */}
                <Betslip
                  legs={betslip}
                  onChange={setBetslip}
                  onPlaced={bump}
                  linked={linked}
                  signedIn={Boolean(me?.user)}
                />
                {me?.user && linked && <LiveFeed appId={activeId} onChange={bump} />}
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
          <MyActivity refreshKey={refreshKey} onChanged={bump} activeTab={view} />
        </section>
      ) : null}

      <footer className="app-foot">
        <span className="muted">
          {appName} is a demo ISV built on the STX Exchange. Orders, balances and the
          order book are real STX preview data.
        </span>
        <PoweredByStx />
      </footer>
    </div>
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
