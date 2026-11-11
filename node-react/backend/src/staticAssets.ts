// Serves the built frontend's /assets/* files gzipped and cacheable, so a page
// load does not re-download about 2 MB of uncompressed JavaScript every time.
//
// Files directly in /assets/ are Vite's build output, named with a content
// hash, so the browser may keep them for good. Files in its folders (brand/,
// providers/) are copied as-is under fixed names, so they are kept for an hour.
// Each file is read and gzipped once, then served from memory.

import { resolve, sep } from "node:path";
import type { Context, Next } from "hono";
import { acceptsGzip } from "./routes/api";

const IMMUTABLE = "public, max-age=31536000, immutable";
const ONE_HOUR = "public, max-age=3600";
// Below this, gzip saves too little to be worth it.
const MIN_GZIP_BYTES = 1024;
const COMPRESSIBLE = /^(text\/|application\/(javascript|json|xml)|image\/svg\+xml)/;

interface Asset {
  body: Uint8Array;
  gzip: Uint8Array | null;
  type: string;
  cacheControl: string;
}

export function assetMiddleware(publicRoot: string) {
  const root = resolve(publicRoot, "assets");
  const cache = new Map<string, Promise<Asset | null>>();

  async function load(relative: string): Promise<Asset | null> {
    const path = resolve(root, relative);
    if (!path.startsWith(root + sep)) return null;
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const body = new Uint8Array(await file.arrayBuffer());
    const type = file.type;
    const gzip = body.length >= MIN_GZIP_BYTES && COMPRESSIBLE.test(type) ? Bun.gzipSync(body) : null;
    return { body, gzip, type, cacheControl: relative.includes("/") ? ONE_HOUR : IMMUTABLE };
  }

  return async (c: Context, next: Next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    let relative: string;
    try {
      relative = decodeURIComponent(c.req.path.slice("/assets/".length));
    } catch {
      return next();
    }
    if (!relative) return next();
    let pending = cache.get(relative);
    if (!pending) {
      pending = load(relative);
      cache.set(relative, pending);
    }
    const asset = await pending;
    if (!asset) {
      cache.delete(relative);
      return next();
    }
    const headers: Record<string, string> = {
      "Content-Type": asset.type,
      "Cache-Control": asset.cacheControl,
    };
    if (asset.gzip) headers.Vary = "Accept-Encoding";
    if (asset.gzip && acceptsGzip(c.req.header("Accept-Encoding"))) {
      headers["Content-Encoding"] = "gzip";
      return new Response(asset.gzip, { headers });
    }
    // Hono drops the body itself on a HEAD request.
    return new Response(asset.body, { headers });
  };
}
