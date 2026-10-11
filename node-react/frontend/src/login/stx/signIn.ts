// Where the sign-in buttons open STX. On a wide screen the STX pages open in
// a popup over the app (the result comes back over postMessage and the popup
// closes); on a phone, or when the browser blocks the popup, the page itself
// goes to STX and returns.

export const POPUP_MIN_WIDTH = 700;

export type Connection = "google" | "apple" | "x";

export type SignInDeps = {
  width: number;
  openPopup: (url: string) => boolean;
  navigate: (url: string) => void;
};

// No connection: STX's own page, where the person logs in with email and
// password or registers. A connection goes straight to that provider.
export function signInUrl(connection?: Connection, backend = ""): string {
  return `${backend}/auth/stx/start${connection ? `?connection=${connection}` : ""}`;
}

export function startSignIn(connection: Connection | undefined, deps: SignInDeps, backend = ""): "popup" | "redirect" {
  const url = signInUrl(connection, backend);
  if (deps.width >= POPUP_MIN_WIDTH && deps.openPopup(url)) return "popup";
  deps.navigate(url);
  return "redirect";
}
