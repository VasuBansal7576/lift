import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../agent/src/config.ts";
import { resolveRuntimePath } from "../../shared/runtime-static.ts";

describe("resolveRuntimePath", () => {
  it("maps /runtime files onto the repo runtime directory", () => {
    expect(resolveRuntimePath("/runtime/runtime.js", ROOT)).toBe(resolve(ROOT, "runtime/runtime.js"));
    expect(resolveRuntimePath("/runtime/checkout-treatment.json", ROOT)).toBe(
      resolve(ROOT, "runtime/checkout-treatment.json"),
    );
  });

  it("rejects path traversal and non-runtime URLs", () => {
    expect(resolveRuntimePath("/runtime/../package.json", ROOT)).toBeNull();
    expect(resolveRuntimePath("/checkout/app.js", ROOT)).toBeNull();
  });
});
