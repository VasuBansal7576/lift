import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../agent/src/config.ts";

describe("origin checkout fail-open and edge origin mode", () => {
  const src = readFileSync(resolve(ROOT, "sites/checkout/app.js"), "utf8");
  const serve = readFileSync(resolve(ROOT, "scripts/serve-site.ts"), "utf8");
  const bootstrap = readFileSync(resolve(ROOT, "edge/bootstrap-flag.ts"), "utf8");

  it("always binds control cart, place-order, and keyboard handlers", () => {
    expect(src).toContain("function bindBaseHandlers");
    expect(src).toMatch(/cart\.addEventListener\("click", openCheckout\)/);
    expect(src).toMatch(/pay\.addEventListener\("click", submitOrder\)/);
    expect(src).toMatch(/keydown/);
    expect(src).toContain("isNativeActivateTarget");
    expect(src).toContain('role === "button"');
    expect(src).toContain("bindBaseHandlers()");
    expect(src.indexOf("bindBaseHandlers()")).toBeLessThan(src.indexOf("initFromFlagsmith"));
    expect(src).not.toMatch(/Flagsmith is required for variant assignment/);
  });

  it("skips the in-page experiment when config.edgeOrigin is set", () => {
    expect(src).toContain("config?.edgeOrigin");
    expect(src).toContain("no in-page experiment");
    expect(src).toContain('dataset.liftOriginMode = "edge"');
    expect(serve).toContain("--edge-origin");
    expect(serve).toContain("extra.edgeOrigin = true");
  });

  it("requires FLAGSMITH_BOOTSTRAP_PASSWORD with no default", () => {
    expect(bootstrap).not.toMatch(/LiftDev123/);
    expect(bootstrap).toContain("FLAGSMITH_BOOTSTRAP_PASSWORD is required");
    expect(bootstrap).not.toMatch(/PASSWORD \|\| /);
  });

  it("commits a live recorder against real Flagsmith, not the mock", () => {
    const rec = readFileSync(resolve(ROOT, "edge/record/live.mjs"), "utf8");
    expect(rec).toContain("2.295.2");
    expect(rec).toContain("startDemoStack");
    expect(rec).toContain("edge/.dev.vars");
    expect(rec).not.toContain("startMockFlagsmith");
    expect(rec).not.toContain("18787");
  });
});
