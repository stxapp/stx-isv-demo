import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { api, setLinkStartPath, type AppResponse } from "./api";
import { App } from "./App";
import { setLinkCopy } from "./components/LinkStx";
import { DEFAULT_LOGIN, linkCopy, linkPath, LoginProvider, retryDelayMs } from "./login";
import "./styles.css";

// The backend says how people get into this deployment (LOGIN_MODE). Read at
// runtime, so one build serves every mode and no rebuild switches it.
function Root() {
  const [boot, setBoot] = useState<AppResponse | undefined>(undefined);
  useEffect(() => {
    let stopped = false;
    // The mode decides which sign-in is drawn and where linking starts, so it
    // is never guessed: if the backend cannot be reached, keep asking.
    (async () => {
      for (let attempt = 0; !stopped; attempt++) {
        try {
          const res = await api.app();
          if (stopped) return;
          const l = res.login ?? DEFAULT_LOGIN;
          setLinkStartPath(linkPath(l));
          setLinkCopy((appName) => linkCopy(l, appName));
          // Kept whole: App draws from this answer instead of asking again.
          setBoot(res);
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }, []);
  if (boot === undefined) return <p className="muted boot-wait">Loading…</p>;
  const login = boot.login ?? DEFAULT_LOGIN;
  return (
    <LoginProvider login={login}>
      <App login={login} boot={boot} />
    </LoginProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
