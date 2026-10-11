import { describe, expect, test } from "bun:test";

// On phones the sign-in card (or the wallet) must come before the markets, or a
// visitor never finds how to log in. The layout is CSS ordering over one render,
// so this checks the markup hook and the phone rules that place it first.
const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
const app = await Bun.file(new URL("./App.tsx", import.meta.url)).text();

function phoneRules(): string {
  const blocks = [...css.matchAll(/@media \(max-width: 860px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]);
  return blocks.join("\n");
}

describe("mobile layout", () => {
  test("sign-in and the wallet render inside the account slot", () => {
    const slot = app.slice(app.indexOf('<div className="account-slot">'));
    expect(slot.indexOf("<SignIn")).toBeGreaterThan(-1);
    expect(slot.indexOf("<Wallets")).toBeGreaterThan(-1);
    expect(slot.indexOf("<SignIn")).toBeLessThan(slot.indexOf("</div>"));
    expect(slot.indexOf("<Wallets")).toBeLessThan(slot.indexOf("</div>"));
  });

  test("on phones the account slot is ordered above the markets, in one column", () => {
    const rules = phoneRules();
    expect(rules).toMatch(/\.trade-col \{ display: contents; \}/);
    expect(rules).toMatch(/\.trade-col > \.account-slot \{ order: -1; \}/);
    expect(rules).toMatch(/\.layout > \.market-col \{ order: 0; \}/);
    expect(rules).toMatch(/grid-template-columns: minmax\(0, 1fr\)/);
  });
});
