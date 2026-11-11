// The built frontend's /assets/* files: gzipped when the browser accepts it,
// kept for good when Vite hashed the name, and never served from outside assets/.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

// Same env block as the other test files (config is built once per process).
process.env.STX_BASE_URL = "https://stx.example.com";
process.env.CLIENT_ID = "sideline-test-client-id";
process.env.CLIENT_SECRET = "sideline-test-client-secret";
process.env.REDIRECT_URI = "http://localhost:8787/callback";
process.env.OAUTH_SCOPES = "profile.read balance.read portfolio.read orders.read orders.write";
process.env.DB_PATH = ":memory:";

const { Hono } = await import("hono");
const { assetMiddleware } = await import("./staticAssets");

const root = mkdtempSync(join(tmpdir(), "assets-test-"));
mkdirSync(join(root, "assets", "brand"), { recursive: true });
const js = "console.log('sideline');\n".repeat(200);
writeFileSync(join(root, "assets", "index-CXg6MevW.js"), js);
writeFileSync(join(root, "assets", "brand", "mark.svg"), `<svg>${"<g/>".repeat(400)}</svg>`);
writeFileSync(join(root, "assets", "tiny-AbCd1234.css"), "a{}");
writeFileSync(join(root, "secret.txt"), "not an asset");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const app = new Hono();
app.use("/assets/*", assetMiddleware(root));
app.all("*", (c) => c.text("fallthrough", 404));

const get = (path: string, encoding?: string, method = "GET") =>
  app.request(path, { method, headers: encoding ? { "Accept-Encoding": encoding } : {} });

describe("assetMiddleware", () => {
  test("gzips a built bundle and lets the browser keep it", async () => {
    const res = await get("/assets/index-CXg6MevW.js", "gzip, br");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("Vary")).toBe("Accept-Encoding");
    expect(res.headers.get("Content-Type")).toContain("javascript");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBeLessThan(js.length);
    expect(gunzipSync(body).toString()).toBe(js);
  });

  test("sends it plain to a browser that refuses gzip", async () => {
    const res = await get("/assets/index-CXg6MevW.js", "gzip;q=0");
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(await res.text()).toBe(js);
  });

  test("keeps a fixed-name file in a folder for an hour only", async () => {
    const res = await get("/assets/brand/mark.svg", "gzip");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
  });

  test("does not gzip a file too small to gain from it", async () => {
    const res = await get("/assets/tiny-AbCd1234.css", "gzip");
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(res.headers.get("Vary")).toBeNull();
    expect(await res.text()).toBe("a{}");
  });

  test("answers HEAD with headers and no body", async () => {
    const res = await get("/assets/index-CXg6MevW.js", "gzip", "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(await res.text()).toBe("");
  });

  test("passes a missing file or a path outside assets/ on", async () => {
    expect(await (await get("/assets/nope-12345678.js")).text()).toBe("fallthrough");
    expect(await (await get("/assets/..%2Fsecret.txt")).text()).toBe("fallthrough");
    expect(await (await get("/assets/%E0%A4%A")).text()).toBe("fallthrough");
  });
});
