import { describe, expect, it } from "vitest";
import { withTrailingSlash } from "../../orchestrator/src/browser.ts";

describe("traffic navigation", () => {
  it("adds a trailing slash so checkout/index.html is served", () => {
    expect(withTrailingSlash("http://127.0.0.1:4174/checkout")).toBe("http://127.0.0.1:4174/checkout/");
    expect(withTrailingSlash("http://127.0.0.1:4174/checkout/")).toBe("http://127.0.0.1:4174/checkout/");
  });

  it("does not append a mock variant query", () => {
    expect(withTrailingSlash("http://127.0.0.1:4174/checkout")).not.toMatch(/lift_variant/);
  });
});
