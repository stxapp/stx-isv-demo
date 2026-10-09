import { PrivyProvider } from "@privy-io/react-auth";
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { api } from "./api";
import { App } from "./App";
import { PrivyBridge } from "./components/PrivySignIn";
import "./styles.css";

// With a Privy App ID from the backend, the app's own login is Privy; without
// one, the mock sign-in. Read at runtime, so no rebuild switches it.
function Root() {
  const [privyAppId, setPrivyAppId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    api
      .app()
      .then((r) => setPrivyAppId(r.privyAppId ?? null))
      .catch(() => setPrivyAppId(null));
  }, []);
  if (privyAppId === undefined) return null;
  if (!privyAppId) return <App privy={false} />;
  return (
    <PrivyProvider
      appId={privyAppId}
      config={{ loginMethods: ["email", "google", "twitter"], appearance: { theme: "dark" } }}
    >
      <PrivyBridge />
      <App privy />
    </PrivyProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
