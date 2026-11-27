import { describe, expect, it } from "vitest";
import { SOFT_INK, SOFT_PAPER, WCAG_AA_MIN } from "../../shared/l3-constants.ts";
import {
  appliedSoftColors,
  assertContrastFloor,
  contrastRatio,
  softenCssPair,
  softenPair,
} from "../../shared/l3-contrast.ts";

describe("L3 soften transform contrast floor", () => {
  it("keeps black-on-white at or above WCAG AA after softening", () => {
    const pair = softenPair([0, 0, 0], [255, 255, 255]);
    expect(pair.contrast).toBeGreaterThanOrEqual(WCAG_AA_MIN);
    expect(assertContrastFloor(pair.fg, pair.bg)).toBeGreaterThanOrEqual(WCAG_AA_MIN);
    expect(pair.fg).not.toEqual([0, 0, 0]);
    expect(pair.bg).not.toEqual([255, 255, 255]);
  });

  it("documents the Sensory-Safe ink/paper pair as AA", () => {
    expect(contrastRatio(SOFT_INK, SOFT_PAPER)).toBeGreaterThanOrEqual(WCAG_AA_MIN);
    const css = softenCssPair("#000000", "#ffffff");
    expect(css.contrast).toBeGreaterThanOrEqual(WCAG_AA_MIN);
    expect(css.fg.startsWith("#")).toBe(true);
    expect(css.bg.startsWith("#")).toBe(true);
  });

  it("raises grey-on-grey until it meets the floor instead of making it worse", () => {
    const input = contrastRatio([185, 190, 198], [216, 220, 227]);
    expect(input).toBeLessThan(WCAG_AA_MIN);
    const pair = softenPair([185, 190, 198], [216, 220, 227]);
    expect(pair.contrast).toBeGreaterThanOrEqual(WCAG_AA_MIN);
  });

  it("softens saturated red-on-white without dropping below AA", () => {
    const pair = softenPair([255, 0, 51], [255, 255, 255]);
    expect(pair.contrast).toBeGreaterThanOrEqual(WCAG_AA_MIN);
    expect(pair.fg[0] - pair.fg[1]).toBeLessThan(255 - 0);
  });

  it("softens the flag ink/paper and reports the contrast actually applied", () => {
    const applied = appliedSoftColors("#000000", "#ffffff");
    expect(applied.contrast).toBeGreaterThanOrEqual(WCAG_AA_MIN);
    expect(applied.fg.toLowerCase()).not.toBe("#000000");
    const low = appliedSoftColors("#c8c8c8", "#dcdcdc");
    expect(low.contrast).toBeGreaterThanOrEqual(WCAG_AA_MIN);
  });
});
