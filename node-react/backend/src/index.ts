// Backend entry point: the confidential OAuth client for the STX ISV demo.
//
// It presents as the ISV app (Heater), holds its client_secret and every STX
// token server-side, brokers the OAuth account-linking flow, tracks the app's
// own mock wallet, and proxies authenticated STX calls on behalf of the
// browser. Start with
// `bun run src/index.ts` (or via Docker Compose).

import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config";
import "./db"; // create tables on boot
import { apiRoutes, UnknownAppError } from "./routes/api";
import { authRoutes } from "./routes/auth";
import { NotLinkedError } from "./stxClient";
import { serveStatic } from "hono/bun";

const app = new Hono();

// Allow the Vite dev-server origin to call us with the session cookie.
app.use(
  "*",
  cors({
    origin: config.frontendUrl,
    credentials: true,
  }),
);

app.get("/health", (c) => c.json({ ok: true, stxBaseUrl: config.stxBaseUrl }));

// OAuth account-linking routes at the root: /login, /callback.
app.route("/", authRoutes);

// App/session/wallet + proxy routes under /api.
app.route("/api", apiRoutes);

// Serve the built frontend (single-origin production deploy). In local dev the
// frontend runs on its own Vite server and ./public is absent, so these no-op.
app.use("/*", serveStatic({ root: "./public" }));
// SPA fallback: any unmatched GET returns index.html so a deep link resolves.
app.get("*", serveStatic({ path: "./public/index.html" }));

// Turn domain errors into clean HTTP statuses rather than a 500.
app.onError((err, c) => {
  if (err instanceof NotLinkedError) {
    return c.json({ error: "not_linked", message: err.message }, 401);
  }
  if (err instanceof UnknownAppError) {
    return c.json({ error: "unknown_app", message: err.message }, 400);
  }
  console.error(err);
  return c.json({ error: "internal_error", message: String(err) }, 500);
});

const enabledApps = config.appList.filter((a) => a.enabled).map((a) => a.id);
console.log(
  `ISV demo backend listening on :${config.port} -> STX ${config.stxBaseUrl} | app: ${enabledApps.join(", ")}`,
);

export default {
  port: config.port,
  fetch: app.fetch,
};
