// Browser check that the sign-in buttons are visible without scrolling on a
// phone. Needs Playwright (not a dependency of this app) and a running build:
//   bun run build && bunx vite preview --port 4317
//   (with the backend on :8787, or VITE_BACKEND_URL set at build time)
//   node scripts/mobile-viewport-check.mjs http://localhost:4317/
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://localhost:4317/";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
await page.goto(url, { waitUntil: "load" });
const button = page.locator("#signin-google");
await button.waitFor({ timeout: 15000 });
const box = await button.boundingBox();
const wide = await page.evaluate(() => document.documentElement.scrollWidth);
await browser.close();
const ok = box !== null && box.y + box.height <= 844 && wide <= 390;
console.log(ok ? "ok" : "FAIL", { button: box, pageWidth: wide });
process.exit(ok ? 0 : 1);
