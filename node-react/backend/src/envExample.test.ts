// .env.example stays in step with the code: every setting the backend reads
// is in it, and it names no setting the backend does not read.

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

const example = await Bun.file(new URL("../../.env.example", import.meta.url)).text();

// Read by the code but deliberately left out of .env.example.
const UNLISTED = new Set([
  "PORT", // set by the host or Docker
  "DB_PATH", // set by docker-compose
  "STX_ISSUER", // only when STX's sign-in documents are served from another address than STX_BASE_URL
  "VENDOR_ALLOW_INSECURE", // tests only: an http:// issuer
  "STX_MARKETS_PATH",
  "STX_TRADES_PATH",
  "STX_SETTLEMENTS_PATH",
]);
// In .env.example for the frontend's dev server, not read by the backend.
const FRONTEND_ONLY = new Set(["VITE_BACKEND_URL"]);

async function settingsRead(): Promise<Set<string>> {
  const names = new Set<string>();
  const src = new URL("./", import.meta.url).pathname;
  for await (const file of new Glob("**/*.ts").scan(src)) {
    if (file.endsWith(".test.ts")) continue;
    const text = await Bun.file(src + file).text();
    for (const m of text.matchAll(/(?:optional|optionalRaw|required|parseCents)\(\s*"([A-Z][A-Z0-9_]*)"/g)) names.add(m[1]!);
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]!);
  }
  return names;
}

function settingsListed(): Set<string> {
  return new Set([...example.matchAll(/^#? ?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!));
}

describe(".env.example", () => {
  test("lists every setting the backend reads", async () => {
    const listed = settingsListed();
    const missing = [...(await settingsRead())].filter((n) => !listed.has(n) && !UNLISTED.has(n));
    expect(missing).toEqual([]);
  });

  test("names no setting the backend does not read", async () => {
    const read = await settingsRead();
    const stale = [...settingsListed()].filter((n) => !read.has(n) && !FRONTEND_ONLY.has(n));
    expect(stale).toEqual([]);
  });

  test("names all three login modes", () => {
    for (const mode of ["own", "stx", "vendor"]) expect(example).toContain(`LOGIN_MODE=${mode}`);
  });
});
