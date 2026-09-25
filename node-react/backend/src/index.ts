// Backend entry point: the confidential OAuth client for the STX ISV demo.
//
// It presents as the ISV app Sideline (a fictional sports app used to
// demonstrate building on STX), holds its client_secret and every STX token
// server-side, brokers the OAuth account-linking flow, tracks the app's own
// mock wallet, and proxies
// authenticated STX calls on behalf of the browser. Start with
// `bun run src/index.ts` (or via Docker Compose).

import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { config } from "./config";
import "./db"; // create tables on boot
import { apiRoutes, UnknownAppError } from "./routes/api";
import { authRoutes } from "./routes/auth";
import { NotLinkedError } from "./stx";
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

app.get("/health", (c) =>
  c.json({ ok: true, stxBaseUrl: config.stxBaseUrl, stxPublicUrl: config.stxPublicUrl, publicUrl: config.publicUrl }),
);

// OAuth account-linking routes at the root: /login, /callback.
app.route("/", authRoutes);

// App/session/wallet + proxy routes under /api.
app.route("/api", apiRoutes);

// Serve the built frontend (single-origin production deploy). In local dev the
// frontend runs on its own Vite server and ./public is absent, so these no-op.
// The page itself is served with this app's public origin filled in (its share
// card needs absolute URLs), so the same build works on any host.
async function indexHtml(c: Context) {
  const file = Bun.file("./public/index.html");
  if (!(await file.exists())) return c.notFound();
  const origin = config.publicUrl || new URL(c.req.url).origin;
  return c.html((await file.text()).replaceAll("__PUBLIC_URL__", origin));
}
app.get("/", indexHtml);
app.get("/index.html", indexHtml);
app.use("/*", serveStatic({ root: "./public" }));
// SPA fallback: any unmatched GET returns index.html so a deep link resolves.
app.get("*", indexHtml);

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

console.log(`ISV demo backend listening on :${config.port} -> STX ${config.stxBaseUrl} | app: ${config.app.id}`);

export default {
  port: config.port,
  fetch: app.fetch,
  // Bun drops a response that sends nothing for 10s by default. The SSE feeds
  // (/api/stream, /api/market-stream) sit idle between events and ping every
  // 25s, so give them headroom; the max Bun accepts is 255s.
  idleTimeout: 120,
};
