import { describe, expect, it } from "vitest";
import { isSafeCss } from "../../runtime/patch-rules.js";
import { CSS_ATTACKS } from "../fixtures/patch-spec-corpus.ts";

describe("isSafeCss allowlist", () => {
  it("accepts the checkout treatment rules", () => {
    expect(
      isSafeCss(
        ".hover-nav:focus-within .hover-menu { display: block; } .contrast-fail { color: #111 !important; background-color: #fff !important; }",
      ),
    ).toBe(true);
  });

  it("rejects every CSS attack fixture after comment-strip and escape-decode", () => {
    for (const attack of CSS_ATTACKS) {
      expect(isSafeCss(attack.css), attack.name).toBe(false);
    }
  });
});
