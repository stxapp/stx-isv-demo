import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { openToken, sealToken } from "./tokenCrypto";

afterEach(() => {
  delete process.env.TOKEN_ENCRYPTION_KEY;
});

test("with a key, tokens are stored encrypted and read back", () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const sealed = sealToken("stxapp_rt_secret");
  expect(sealed.startsWith("enc:v1:")).toBe(true);
  expect(sealed).not.toContain("stxapp_rt_secret");
  expect(openToken(sealed)).toBe("stxapp_rt_secret");
});

test("a tampered token fails to open", () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const sealed = sealToken("stxapp_at_secret");
  // Change one character of the ciphertext to a different one.
  const at = sealed.length - 2;
  const tampered = sealed.slice(0, at) + (sealed[at] === "A" ? "B" : "A") + sealed.slice(at + 1);
  expect(tampered).not.toBe(sealed);
  expect(() => openToken(tampered)).toThrow();
});

test("a link sealed under a key that is gone reads as not linked instead of failing", async () => {
  process.env.STX_BASE_URL ??= "https://stx.example.com";
  process.env.CLIENT_ID ??= "sideline-test-client-id";
  process.env.CLIENT_SECRET ??= "sideline-test-client-secret";
  process.env.REDIRECT_URI ??= "http://localhost:8787/callback";
  process.env.DB_PATH ??= ":memory:";
  const { linkStore } = await import("./stores");
  const link = { userId: `u-${crypto.randomUUID()}`, appId: "sideline", accessToken: "at", refreshToken: "rt", accessExpiresAt: null, scopes: [] };

  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  linkStore.save(link);
  expect(linkStore.get(link.userId)?.accessToken).toBe("at");

  // The key is replaced: the stored tokens can no longer be read.
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  expect(linkStore.get(link.userId)).toBeNull();
  // Linking again writes a readable row.
  linkStore.save({ ...link, accessToken: "at2" });
  expect(linkStore.get(link.userId)?.accessToken).toBe("at2");
});

test("without a key, tokens pass through and old plain rows still read", () => {
  expect(sealToken("plain")).toBe("plain");
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  expect(openToken("plain-from-before")).toBe("plain-from-before");
});
