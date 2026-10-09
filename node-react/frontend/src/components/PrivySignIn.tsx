import { usePrivy } from "@privy-io/react-auth";
import { useEffect, useRef, useState } from "react";
import { track } from "../analytics";
import { api, linkUrl, setConnectHint, type PublicApp } from "../api";
import { privyActions } from "../privyBridge";

// Registers Privy's logout for App's sign-out. Rendered inside PrivyProvider.
export function PrivyBridge() {
  const { logout } = usePrivy();
  useEffect(() => {
    privyActions.logout = logout;
    return () => {
      privyActions.logout = null;
    };
  }, [logout]);
  return null;
}

// Sign in with the app's own login (Privy: email, Google or X), then connect
// STX. After Privy, the server verifies the token and signs the user in; if the
// user has no STX connection yet, the STX connect opens straight away as a
// full-page redirect (a popup here would be blocked: it is not a click), pointed
// at the same provider and account.
export function PrivySignIn({ app, onSignedIn }: { app: PublicApp; onSignedIn: () => void }) {
  const { ready, authenticated, login, getAccessToken } = usePrivy();
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  useEffect(() => {
    if (!ready || !authenticated || done.current) return;
    done.current = true;
    (async () => {
      try {
        const token = await getAccessToken();
        if (!token) throw new Error("No Privy session");
        const res = await api.privyLogin(token);
        setConnectHint(res.connectHint);
        track("sign_in");
        onSignedIn();
        const me = await api.me();
        if (!me.link.connected) {
          track("link_start");
          window.location.assign(linkUrl(res.connectHint));
        }
      } catch (err) {
        done.current = false;
        setError(String(err));
      }
    })();
  }, [ready, authenticated, getAccessToken, onSignedIn]);

  return (
    <div className="card signin">
      <h3>Sign in to {app.name}</h3>
      <p className="fiction-note">
        {app.name} is a fictional sports app used to demonstrate building on STX. It is not a
        real product or company.
      </p>
      <p className="muted">
        {app.name} has its own login (Privy). After you sign in, connect your STX account once;
        next time it's just your {app.name} login.
      </p>
      <button className="primary" type="button" disabled={!ready} onClick={() => login()}>
        {authenticated ? "Signing in…" : `Sign in to ${app.name}`}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
