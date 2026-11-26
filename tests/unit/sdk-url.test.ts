import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../agent/src/config.ts";

describe("checkout JS SDK URL", () => {
  it("loads @flagsmith/flagsmith@12.4.0 ESM from jsdelivr, not flagsmith@12.4.0", () => {
    const src = readFileSync(resolve(ROOT, "sites/checkout/app.js"), "utf8");
    expect(src).toContain(
      "https://cdn.jsdelivr.net/npm/@flagsmith/flagsmith@12.4.0/+esm",
    );
    expect(src).not.toContain("npm/flagsmith@12.4.0");
  });
});
