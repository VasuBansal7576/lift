export function relativeLuminance(r: number, g: number, b: number): number {
  const lin = [r, g, b].map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function contrastRatio(
  fg: [number, number, number],
  bg: [number, number, number],
): number {
  const l1 = relativeLuminance(...fg);
  const l2 = relativeLuminance(...bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function clampChannel(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function parseHex(color: string): [number, number, number] | null {
  const hex = color.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(hex);
  if (short) {
    const [r, g, b] = short[1].split("").map((c) => Number.parseInt(c + c, 16));
    return [r, g, b];
  }
  const long = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(hex);
  if (long) {
    const n = long[1];
    return [
      Number.parseInt(n.slice(0, 2), 16),
      Number.parseInt(n.slice(2, 4), 16),
      Number.parseInt(n.slice(4, 6), 16),
    ];
  }
  return null;
}

function parseRgbFunction(color: string): [number, number, number] | null {
  const legacy = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i.exec(
    color,
  );
  if (legacy) {
    return [clampChannel(Number(legacy[1])), clampChannel(Number(legacy[2])), clampChannel(Number(legacy[3]))];
  }
  const modern = /^rgba?\(\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/i.exec(color);
  if (modern) {
    return [clampChannel(Number(modern[1])), clampChannel(Number(modern[2])), clampChannel(Number(modern[3]))];
  }
  return null;
}

function hueToRgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

function parseHslFunction(color: string): [number, number, number] | null {
  const m =
    /^hsla?\(\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)%\s*[, ]\s*(\d+(?:\.\d+)?)%/i.exec(
      color,
    );
  if (!m) return null;
  const h = ((Number(m[1]) % 360) + 360) % 360 / 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  if (s === 0) {
    const v = clampChannel(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    clampChannel(hueToRgb(p, q, h + 1 / 3) * 255),
    clampChannel(hueToRgb(p, q, h) * 255),
    clampChannel(hueToRgb(p, q, h - 1 / 3) * 255),
  ];
}

/** Parse a CSS color; throws if the value cannot be turned into sRGB. */
export function parseCssColor(color: string): [number, number, number] {
  const value = color.trim().toLowerCase();
  if (value === "transparent") {
    throw new Error(`Cannot compute contrast against transparent (${color})`);
  }
  const hex = parseHex(value);
  if (hex) return hex;
  const rgb = parseRgbFunction(value);
  if (rgb) return rgb;
  const hsl = parseHslFunction(value);
  if (hsl) return hsl;
  throw new Error(`Unparsed CSS color: ${color}`);
}

/** @deprecated use parseCssColor — kept so existing imports keep compiling during the swap. */
export function parseRgb(color: string): [number, number, number] | null {
  try {
    return parseCssColor(color);
  } catch {
    return null;
  }
}
