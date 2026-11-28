import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../agent/src/config.ts";
import { main, validateSpecFile, wranglerPutArgs } from "../../edge/put-spec.ts";

describe("edge:put-spec validation", () => {
  it("accepts the checkout treatment spec", () => {
    const result = validateSpecFile(resolve(ROOT, "runtime/checkout-treatment.json"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.id).toBe("checkout-treatment-v0");
    expect(result.spec.version).toBe(0);
  });

  it("rejects unknown ops and script injection", () => {
    const result = validateSpecFile(resolve(ROOT, "package.json"));
    expect(result.ok).toBe(false);
  });

  it("rejects a missing file", () => {
    const result = validateSpecFile(resolve(ROOT, "runtime/does-not-exist.json"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not found/);
  });

  it("CLI --validate-only exits 0 for the treatment spec", () => {
    const code = main(["--validate-only", resolve(ROOT, "runtime/checkout-treatment.json")]);
    expect(code).toBe(0);
  });

  it("CLI --validate-only exits 1 for invalid JSON that is not a spec", () => {
    const code = main(["--validate-only", resolve(ROOT, "package.json")]);
    expect(code).toBe(1);
  });

  it("builds a local-only wrangler kv put (never remote)", () => {
    const args = wranglerPutArgs("checkout-treatment-v0", "/tmp/spec.json");
    expect(args).toContain("--local");
    expect(args).toContain("SPECS");
    expect(args).not.toContain("--remote");
  });
});
