import { describe, expect, it } from "vitest";
import { contrastRatio, parseCssColor } from "../../traffic/src/contrast.ts";

describe("parseCssColor", () => {
  it("parses hex, rgb, rgba, hsl, and modern rgb", () => {
    expect(parseCssColor("#111")).toEqual([17, 17, 17]);
    expect(parseCssColor("#ffffff")).toEqual([255, 255, 255]);
    expect(parseCssColor("rgb(185, 190, 198)")).toEqual([185, 190, 198]);
    expect(parseCssColor("rgba(185, 190, 198, 1)")).toEqual([185, 190, 198]);
    expect(parseCssColor("rgb(185 190 198)")).toEqual([185, 190, 198]);
    expect(parseCssColor("hsl(0, 0%, 0%)")).toEqual([0, 0, 0]);
  });

  it("throws on unparsed colours", () => {
    expect(() => parseCssColor("rebeccapurple")).toThrow(/Unparsed CSS color/);
    expect(() => parseCssColor("transparent")).toThrow(/transparent/);
  });

  it("flags grey-on-grey below 4.5:1", () => {
    const ratio = contrastRatio(
      parseCssColor("#b9bec6"),
      parseCssColor("#d8dce3"),
    );
    expect(ratio).toBeLessThan(4.5);
  });
});
