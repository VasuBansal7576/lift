import { contrastRatio, parseCssColor } from "../traffic/src/contrast.ts";
import {
  SOFT_INK,
  SOFT_PAPER,
  WCAG_AA_MIN,
} from "./l3-constants.ts";

export { contrastRatio, parseCssColor };

function clampChannel(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb.map((c) => clampChannel(c).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(rgb: [number, number, number]): number {
  const lin = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function desaturate(rgb: [number, number, number], amount: number): [number, number, number] {
  const gray = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return [
    clampChannel(rgb[0] + (gray - rgb[0]) * amount),
    clampChannel(rgb[1] + (gray - rgb[1]) * amount),
    clampChannel(rgb[2] + (gray - rgb[2]) * amount),
  ];
}

function mix(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [
    clampChannel(a[0] + (b[0] - a[0]) * t),
    clampChannel(a[1] + (b[1] - a[1]) * t),
    clampChannel(a[2] + (b[2] - a[2]) * t),
  ];
}

function darken(rgb: [number, number, number], amount: number): [number, number, number] {
  return [
    clampChannel(rgb[0] * (1 - amount)),
    clampChannel(rgb[1] * (1 - amount)),
    clampChannel(rgb[2] * (1 - amount)),
  ];
}

function lighten(rgb: [number, number, number], amount: number): [number, number, number] {
  return [
    clampChannel(rgb[0] + (255 - rgb[0]) * amount),
    clampChannel(rgb[1] + (255 - rgb[1]) * amount),
    clampChannel(rgb[2] + (255 - rgb[2]) * amount),
  ];
}

export function assertContrastFloor(
  fg: [number, number, number],
  bg: [number, number, number],
  min = WCAG_AA_MIN,
): number {
  const ratio = contrastRatio(fg, bg);
  if (ratio < min) {
    throw new Error(
      `Contrast ${ratio.toFixed(3)}:1 is below WCAG AA ${min}:1 for ${rgbToHex(fg)} on ${rgbToHex(bg)}`,
    );
  }
  return ratio;
}

/**
 * Moderate soften: drop saturation, replace harsh black-on-white, then
 * push the pair apart until WCAG AA 4.5:1 holds. Never returns a pair below the floor.
 */
export function softenPair(
  fg: [number, number, number],
  bg: [number, number, number],
): { fg: [number, number, number]; bg: [number, number, number]; contrast: number } {
  let nextFg = desaturate(fg, 0.28);
  let nextBg = desaturate(bg, 0.22);

  const fgLum = luminance(fg);
  const bgLum = luminance(bg);
  if (fgLum < 0.2 && bgLum > 0.8) {
    nextFg = mix(nextFg, SOFT_INK, 0.85);
    nextBg = mix(nextBg, SOFT_PAPER, 0.85);
  } else if (bgLum < 0.2 && fgLum > 0.8) {
    nextBg = mix(nextBg, SOFT_INK, 0.85);
    nextFg = mix(nextFg, SOFT_PAPER, 0.85);
  }

  let guard = 0;
  while (contrastRatio(nextFg, nextBg) < WCAG_AA_MIN && guard < 80) {
    if (luminance(nextFg) <= luminance(nextBg)) {
      nextFg = darken(nextFg, 0.06);
      nextBg = lighten(nextBg, 0.04);
    } else {
      nextBg = darken(nextBg, 0.06);
      nextFg = lighten(nextFg, 0.04);
    }
    guard += 1;
  }

  const contrast = assertContrastFloor(nextFg, nextBg);
  return { fg: nextFg, bg: nextBg, contrast };
}

export function softenCssPair(
  fg: string,
  bg: string,
): { fg: string; bg: string; contrast: number } {
  const pair = softenPair(parseCssColor(fg), parseCssColor(bg));
  return { fg: rgbToHex(pair.fg), bg: rgbToHex(pair.bg), contrast: pair.contrast };
}
