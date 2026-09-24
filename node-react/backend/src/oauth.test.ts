// Unit tests for the OAuth client against the real STX contract. No live server
// is needed: these assert the *shape* of every request the client sends and the
// parsing of the token response, which is what a live exchange would exercise.
//
// `config` reads required env vars at import time, so set them before importing
// the modules under test (hence the top-level await imports below).

import { describe, expect, test } from "bun:test";

process.env.STX_BASE_URL = "https://stx.example.com";
// The Heater app profile.
process.env.CLIENT_ID = "stx_client_HEATER";
process.env.CLIENT_SECRET = "stx_secret_HEATER";
process.env.REDIRECT_URI = "http://localhost:8787/callback";
process.env.OAUTH_SCOPES = "profile.read balance.read portfolio.read orders.read orders.write";
// The `config` singleton is shared across test files in one process; this env
// block matches stores.test.ts (incl. DB_PATH) so whichever loads it first,
// both see the same profile and an in-memory DB.
process.env.DB_PATH = ":memory:";

const oauth = await import("./oauth");
const { config } = await import("./config");

const heater = config.apps["heater"]!;

describe("app profile", () => {
  test("heater is the default, enabled, with its own client credentials", () => {
    expect(config.defaultAppId).toBe("heater");
    expect(heater.enabled).toBe(true);
    expect(heater.clientId).toBe("stx_client_HEATER");
    expect(heater.name).toBe("Heater");
  });
});

describe("PKCE (RFC 7636 S256)", () => {
  // The canonical RFC 7636 Appendix B vector — also the server's own Pkce
  // doctest, so deriving the same challenge proves the client speaks the exact
  // dialect STX verifies against.
  test("codeChallengeS256 matches the RFC 7636 test vector", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await oauth.codeChallengeS256(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("generateCodeVerifier is 43-char unpadded base64url, unique per call", () => {
    const a = oauth.generateCodeVerifier();
    const b = oauth.generateCodeVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes -> 43 chars, no '='
    expect(a).not.toBe(b);
  });

  test("a freshly generated verifier round-trips to its own challenge", async () => {
    const verifier = oauth.generateCodeVerifier();
    const challenge = await oauth.codeChallengeS256(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toContain("=");
  });
});

describe("authorize URL builder", () => {
  test("carries every required param, with the app's own client_id/scope", () => {
    const url = new URL(
      oauth.buildAuthorizeUrl(heater, { state: "st-123", codeChallenge: "chal-abc" }),
    );
    expect(url.origin + url.pathname).toBe("https://stx.example.com/oauth/authorize");

    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe("stx_client_HEATER");
    expect(p.get("redirect_uri")).toBe("http://localhost:8787/callback");
    // Space-delimited scope (URLSearchParams encodes the spaces on the wire;
    // .get() decodes them back).
    expect(p.get("scope")).toBe("profile.read balance.read portfolio.read orders.read orders.write");
    expect(p.get("code_challenge")).toBe("chal-abc");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("state")).toBe("st-123");
  });
});

describe("token endpoint request shapes", () => {
  test("client_secret_basic header is base64(client_id:secret) for the app", () => {
    const header = oauth.basicAuthHeader(heater);
    expect(header.startsWith("Basic ")).toBe(true);
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString();
    expect(decoded).toBe("stx_client_HEATER:stx_secret_HEATER");
  });

  test("authorization_code body carries code, redirect_uri, code_verifier — no client creds", () => {
    const body = oauth.buildTokenExchangeParams(heater, {
      code: "stx_code_XYZ",
      codeVerifier: "verifier-123",
    });
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("stx_code_XYZ");
    expect(body.get("redirect_uri")).toBe("http://localhost:8787/callback");
    expect(body.get("code_verifier")).toBe("verifier-123");
    // Client is authenticated via HTTP Basic; creds must not be in the body.
    expect(body.get("client_id")).toBeNull();
    expect(body.get("client_secret")).toBeNull();
  });

  test("refresh_token body carries only grant_type + refresh_token", () => {
    const body = oauth.buildRefreshParams("stx_rt_ABC");
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("stx_rt_ABC");
    expect(body.get("client_id")).toBeNull();
    expect(body.get("client_secret")).toBeNull();
  });
});

describe("token response parser", () => {
  test("parses a full RFC 6749 §5.1 response", () => {
    const parsed = oauth.parseTokenResponse({
      access_token: "stx_at_AAA",
      refresh_token: "stx_rt_BBB",
      token_type: "bearer",
      expires_in: 3600,
      scope: "profile.read balance.read orders.write",
    });
    expect(parsed.access_token).toBe("stx_at_AAA");
    expect(parsed.refresh_token).toBe("stx_rt_BBB");
    expect(parsed.token_type).toBe("bearer");
    expect(parsed.expires_in).toBe(3600);
    expect(parsed.scope).toBe("profile.read balance.read orders.write");
  });

  test("access_token alone is valid; optional fields are dropped when absent", () => {
    const parsed = oauth.parseTokenResponse({ access_token: "stx_at_only" });
    expect(parsed.access_token).toBe("stx_at_only");
    expect(parsed.refresh_token).toBeUndefined();
    expect(parsed.expires_in).toBeUndefined();
  });

  test("throws when access_token is missing or malformed", () => {
    expect(() => oauth.parseTokenResponse({ token_type: "bearer" })).toThrow();
    expect(() => oauth.parseTokenResponse({ access_token: "" })).toThrow();
    expect(() => oauth.parseTokenResponse(null)).toThrow();
    expect(() => oauth.parseTokenResponse("not-json")).toThrow();
  });

  test("expiryFrom converts expires_in seconds to an absolute epoch-ms expiry", () => {
    const before = Date.now();
    const expiry = oauth.expiryFrom({ access_token: "x", expires_in: 3600 });
    expect(expiry).not.toBeNull();
    expect(expiry as number).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(oauth.expiryFrom({ access_token: "x" })).toBeNull();
  });
});
