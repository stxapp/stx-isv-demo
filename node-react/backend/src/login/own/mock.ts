// The mock login: a stand-in for the app already having accounts of its own.
// There is no password and no account behind it. It exists so the demo runs
// with nothing but STX credentials; a real app has a real login here.

import { Hono } from "hono";
import { config } from "../../config";
import { publicUser } from "../../helpers";
import { getOrCreateSession } from "../../session";
import { userStore } from "../../stores";

export function mockLoginRoutes(): Hono {
  const routes = new Hono();

  // POST /api/login. Body: { name? }. Creates the user and wallet for this
  // browser session if absent. Idempotent.
  routes.post("/api/login", async (c) => {
    const app = config.app;
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const name = typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : `${app.name} demo user`;
    const user = userStore.ensure({
      sessionId: getOrCreateSession(c),
      appId: app.id,
      name,
      startingWalletCents: app.startingWalletCents,
    });
    return c.json({ user: publicUser(user) });
  });

  return routes;
}
