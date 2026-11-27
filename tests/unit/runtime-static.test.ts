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

  it("does not throw on malformed percent-encoding", () => {
    expect(() => resolveRuntimePath("/runtime/%E0%A4%A", ROOT)).not.toThrow();
    expect(resolveRuntimePath("/runtime/%E0%A4%A", ROOT)).toBeNull();
  });

  it("rejects NUL bytes so %00 cannot resolve to the runtime directory", () => {
    expect(resolveRuntimePath("/runtime/%00", ROOT)).toBeNull();
    expect(resolveRuntimePath("/runtime/%00/runtime.js", ROOT)).toBeNull();
    expect(resolveRuntimePath("/runtime/runtime.js%00", ROOT)).toBeNull();
  });
});
