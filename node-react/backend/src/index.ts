// Backend entry point: the confidential client for the STX demo app.
//
// It presents as one fictional sports app (Sideline, Playbook, ... by
// configuration), holds its client_secret and every STX token server-side,
// signs people in the way LOGIN_MODE says, tracks the app's own mock wallet,
// and proxies
// authenticated STX calls on behalf of the browser. Start with
// `bun run src/index.ts` (or via Docker Compose).

import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { config } from "./config";
import "./db"; // create tables on boot
import { brandIndexHtml } from "./brand";
import { apiRoutes, UnknownAppError } from "./routes/api";
import { LOGIN_PATHS, loginRoutes } from "./login";
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
  c.json({ ok: true, loginMode: config.login.mode, stxBaseUrl: config.stxBaseUrl, stxPublicUrl: config.stxPublicUrl, publicUrl: config.publicUrl }),
);

// Signing in and linking an STX account: the routes of the configured login
// mode (LOGIN_MODE), each mode in its own folder under ./login/.
app.route("/", loginRoutes());
for (const path of LOGIN_PATHS) {
  app.all(path, (c) => c.json({ error: "not_in_this_login_mode", loginMode: config.login.mode }, 404));
}

// App/session/wallet + proxy routes under /api.
app.route("/api", apiRoutes);

// Serve the built frontend (single-origin production deploy). In local dev the
// frontend runs on its own Vite server and ./public is absent, so these no-op.
// The page itself is served with this deployment's origin, name and icons
// filled in (see brand.ts), so the same build works on any host and as any app.
async function indexHtml(c: Context) {
  const file = Bun.file("./public/index.html");
  if (!(await file.exists())) return c.notFound();
  const { id, name } = config.app;
  return c.html(
    brandIndexHtml(await file.text(), {
      origin: config.publicUrl || new URL(c.req.url).origin,
      appId: id,
      appName: name,
      hasIcon: await Bun.file(`./public/assets/brand/${id}-icon.svg`).exists(),
      hasImages: await Bun.file(`./public/assets/brand/${id}/og-image.png`).exists(),
    }),
  );
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

const login = config.login.mode === "own" ? `own (${config.login.own})` : config.login.mode;
console.log(
  `ISV demo backend listening on :${config.port} -> STX ${config.stxBaseUrl} | app: ${config.app.id} | login mode: ${login}`,
);

export default {
  port: config.port,
  fetch: app.fetch,
  // Bun drops a response that sends nothing for 10s by default. The SSE feeds
  // (/api/stream, /api/market-stream) sit idle between events and ping every
  // 25s, so give them headroom; the max Bun accepts is 255s.
  idleTimeout: 120,
};
