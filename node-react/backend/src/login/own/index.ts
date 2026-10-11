// Login mode `own`: the app has its own login, then the user links their STX
// account.
//
// Two steps, two systems:
//   1. The user signs in to the app. Which login the app uses is the app's
//      business. This demo ships two: Privy (./privy.ts) and a mock
//      (./mock.ts). Any login that ends with "this request is from user X"
//      works the same way: replace the one route in ./privy.ts.
//   2. The signed-in user links their STX account (../link.ts). STX never sees
//      the app's login, and the app never sees the user's STX password.

import { Hono } from "hono";
import type { OwnLogin } from "../../config";
import { linkRoutes } from "../link";
import { mockLoginRoutes } from "./mock";
import { privyLoginRoutes } from "./privy";

export function ownLoginRoutes(which: OwnLogin): Hono {
  const routes = new Hono();
  routes.route("/", which === "privy" ? privyLoginRoutes() : mockLoginRoutes());
  // With a real login, linking needs a signed-in user.
  routes.route("/", linkRoutes({ requireSignedIn: which === "privy" }));
  return routes;
}
