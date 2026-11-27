import { describe, expect, it } from "vitest";
import { decodeCssEscapes, isSafeCss, parsePatchSpec } from "../../runtime/patch-rules.js";
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

  it("never throws on oversized CSS escapes and rejects them", () => {
    const css = ".x { color: \\110000; }";
    expect(() => decodeCssEscapes(css)).not.toThrow();
    expect(() => isSafeCss(css)).not.toThrow();
    expect(isSafeCss(css)).toBe(false);
    expect(() =>
      parsePatchSpec({ id: "esc", version: 0, ops: [{ op: "injectCSS", css }] }),
    ).not.toThrow();
    expect(parsePatchSpec({ id: "esc", version: 0, ops: [{ op: "injectCSS", css }] }).ok).toBe(
      false,
    );
  });
});
