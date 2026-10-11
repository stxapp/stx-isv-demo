import { describe, expect, test } from "bun:test";
import { startSignIn } from "./signIn";

function deps(width: number, popupOpens: boolean) {
  const calls = { popup: [] as string[], navigate: [] as string[] };
  return {
    calls,
    deps: {
      width,
      openPopup: (url: string) => {
        calls.popup.push(url);
        return popupOpens;
      },
      navigate: (url: string) => void calls.navigate.push(url),
    },
  };
}

describe("starting a login at STX", () => {
  test("a wide screen opens STX in a popup and stays on the page", () => {
    const { calls, deps: d } = deps(1280, true);
    expect(startSignIn("google", d)).toBe("popup");
    expect(calls.popup).toEqual(["/auth/stx/start?connection=google"]);
    expect(calls.navigate).toEqual([]);
  });

  test("a blocked popup falls back to the full-page redirect", () => {
    const { calls, deps: d } = deps(1280, false);
    expect(startSignIn("google", d)).toBe("redirect");
    expect(calls.navigate).toEqual(["/auth/stx/start?connection=google"]);
  });

  test("a phone-width screen redirects without trying a popup", () => {
    const { calls, deps: d } = deps(390, true);
    expect(startSignIn("google", d)).toBe("redirect");
    expect(calls.popup).toEqual([]);
    expect(calls.navigate).toEqual(["/auth/stx/start?connection=google"]);
  });

  test("the STX account button goes to STX's own page, with no connection", () => {
    const { calls, deps: d } = deps(1280, true);
    expect(startSignIn(undefined, d)).toBe("popup");
    expect(calls.popup).toEqual(["/auth/stx/start"]);
  });

  test("in local development the URL is on the backend's origin", () => {
    const { calls, deps: d } = deps(1280, true);
    startSignIn("google", d, "http://localhost:8787");
    expect(calls.popup).toEqual(["http://localhost:8787/auth/stx/start?connection=google"]);
  });

  test("Apple and X go to STX with their own connection", () => {
    for (const c of ["apple", "x"] as const) {
      const { calls, deps: d } = deps(1280, true);
      expect(startSignIn(c, d)).toBe("popup");
      expect(calls.popup).toEqual([`/auth/stx/start?connection=${c}`]);
    }
  });
});

describe("sign-in buttons", () => {
  test("the provider shortcuts are Google, Apple and X, each with its mark", async () => {
    const { PROVIDERS } = await import("./providers");
    expect(PROVIDERS.map((p) => [p.connection, p.label])).toEqual([
      ["google", "Continue with Google"],
      ["apple", "Continue with Apple"],
      ["x", "Continue with X"],
    ]);
    for (const p of PROVIDERS) {
      expect(await Bun.file(new URL(`../../../public${p.logo}`, import.meta.url)).exists()).toBe(true);
    }
  });
});
