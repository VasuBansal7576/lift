import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "../../orchestrator/src/paths.ts";

describe("traffic navigation", () => {
  it("gotoSite adds a trailing slash so checkout/index.html is served", () => {
    const source = readFileSync(resolve(REPO_ROOT, "orchestrator/src/browser.ts"), "utf8");
    const fn = source.slice(source.indexOf("export async function gotoSite"), source.indexOf("export async function gotoControl"));
    expect(fn).toMatch(/siteUrl\.endsWith\("\/"\)/);
    expect(fn).not.toMatch(/lift_variant/);
  });
});
