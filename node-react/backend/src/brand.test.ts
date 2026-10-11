// One built page serves any app: the origin, name and icons are filled in when
// it is served. Checked against the real frontend/index.html.

import { describe, expect, test } from "bun:test";
import { brandIndexHtml } from "./brand";

const html = await Bun.file(new URL("../../frontend/index.html", import.meta.url)).text();

describe("the served page", () => {
  test("Sideline: only the origin is filled in", () => {
    const out = brandIndexHtml(html, {
      origin: "https://sideline.example.com",
      appId: "sideline",
      appName: "Sideline",
      hasIcon: true,
      hasImages: false,
    });
    expect(out).toBe(html.replaceAll("__PUBLIC_URL__", "https://sideline.example.com"));
    expect(out).toContain("<title>Sideline: STX sample app</title>");
    expect(out).not.toContain("__PUBLIC_URL__");
  });

  test("the default app under another name keeps its icons and takes the name", () => {
    const out = brandIndexHtml(html, { origin: "https://x.example.com", appId: "sideline", appName: "Touchline", hasIcon: true, hasImages: false });
    expect(out).toContain("<title>Touchline: STX sample app</title>");
    expect(out).toContain('href="/assets/brand/sideline-icon.svg"');
    expect(out).toContain('href="/assets/brand/favicon-32.png"');
  });

  test("another app with its own assets gets its name, icon and images", () => {
    const out = brandIndexHtml(html, {
      origin: "https://playbook.example.com",
      appId: "playbook",
      appName: "Playbook",
      hasIcon: true,
      hasImages: true,
    });
    expect(out).toContain("<title>Playbook: STX sample app</title>");
    expect(out).toContain('href="/assets/brand/playbook-icon.svg"');
    expect(out).toContain('href="/assets/brand/playbook/favicon-32.png"');
    expect(out).toContain('content="https://playbook.example.com/assets/brand/playbook/og-image.png"');
    expect(out).not.toContain("Sideline");
    expect(out).not.toContain("sideline");
  });

  test("an app with no assets of its own keeps the default icons under its own name", () => {
    const out = brandIndexHtml(html, {
      origin: "https://x.example.com",
      appId: "clubhouse",
      appName: "Club <House>",
      hasIcon: false,
      hasImages: false,
    });
    expect(out).toContain("<title>Club &#60;House&#62;: STX sample app</title>");
    expect(out).toContain('href="/assets/brand/sideline-icon.svg"');
    expect(out).toContain('href="/assets/brand/favicon-32.png"');
  });
});
