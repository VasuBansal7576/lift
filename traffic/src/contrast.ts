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

function parseAlphaToken(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 1;
  const trimmed = raw.trim();
  if (trimmed.endsWith("%")) {
    const n = Number(trimmed.slice(0, -1));
    if (!Number.isFinite(n)) throw new Error(`Unparsed CSS color alpha: ${raw}`);
    return Math.max(0, Math.min(1, n / 100));
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n)) throw new Error(`Unparsed CSS color alpha: ${raw}`);
  return Math.max(0, Math.min(1, n));
}

function composite(
  fg: [number, number, number],
  alpha: number,
  bg: [number, number, number],
): [number, number, number] {
  return [
    clampChannel(fg[0] * alpha + bg[0] * (1 - alpha)),
    clampChannel(fg[1] * alpha + bg[1] * (1 - alpha)),
    clampChannel(fg[2] * alpha + bg[2] * (1 - alpha)),
  ];
}

function applyAlpha(
  rgb: [number, number, number],
  alpha: number,
  color: string,
  compositeOver?: [number, number, number],
): [number, number, number] {
  if (alpha >= 1) return rgb;
  if (alpha <= 0) {
    throw new Error(`Cannot compute contrast against transparent (${color})`);
  }
  if (!compositeOver) {
    throw new Error(
      `CSS color ${color} has alpha ${alpha}; composite over a background or throw.`,
    );
  }
  return composite(rgb, alpha, compositeOver);
}

function parseHex(color: string): { rgb: [number, number, number]; alpha: number } | null {
  const hex = color.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(hex);
  if (short) {
    const [r, g, b] = short[1].split("").map((c) => Number.parseInt(c + c, 16));
    return { rgb: [r, g, b], alpha: 1 };
  }
  const shortAlpha = /^#([0-9a-f]{4})$/i.exec(hex);
  if (shortAlpha) {
    const [r, g, b, a] = shortAlpha[1].split("").map((c) => Number.parseInt(c + c, 16));
    return { rgb: [r, g, b], alpha: a / 255 };
  }
  const long = /^#([0-9a-f]{6})$/i.exec(hex);
  if (long) {
    const n = long[1];
    return {
      rgb: [
        Number.parseInt(n.slice(0, 2), 16),
        Number.parseInt(n.slice(2, 4), 16),
        Number.parseInt(n.slice(4, 6), 16),
      ],
      alpha: 1,
    };
  }
  const longAlpha = /^#([0-9a-f]{8})$/i.exec(hex);
  if (longAlpha) {
    const n = longAlpha[1];
    return {
      rgb: [
        Number.parseInt(n.slice(0, 2), 16),
        Number.parseInt(n.slice(2, 4), 16),
        Number.parseInt(n.slice(4, 6), 16),
      ],
      alpha: Number.parseInt(n.slice(6, 8), 16) / 255,
    };
  }
  return null;
}

function parseRgbFunction(
  color: string,
): { rgb: [number, number, number]; alpha: number } | null {
  const legacy =
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*([^)]+))?\s*\)/i.exec(
      color,
    );
  if (legacy) {
    return {
      rgb: [
        clampChannel(Number(legacy[1])),
        clampChannel(Number(legacy[2])),
        clampChannel(Number(legacy[3])),
      ],
      alpha: parseAlphaToken(legacy[4]),
    };
  }
  const modern =
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)(?:\s*\/\s*([^)]+))?\s*\)/i.exec(
      color,
    );
  if (modern) {
    return {
      rgb: [
        clampChannel(Number(modern[1])),
        clampChannel(Number(modern[2])),
        clampChannel(Number(modern[3])),
      ],
      alpha: parseAlphaToken(modern[4]),
    };
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

function parseHslFunction(
  color: string,
): { rgb: [number, number, number]; alpha: number } | null {
  const m =
    /^hsla?\(\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)%\s*[, ]\s*(\d+(?:\.\d+)?)%(?:\s*[,/]\s*([^)]+))?\s*\)/i.exec(
      color,
    );
  if (!m) return null;
  const h = (((Number(m[1]) % 360) + 360) % 360) / 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const alpha = parseAlphaToken(m[4]);
  if (s === 0) {
    const v = clampChannel(l * 255);
    return { rgb: [v, v, v], alpha };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    rgb: [
      clampChannel(hueToRgb(p, q, h + 1 / 3) * 255),
      clampChannel(hueToRgb(p, q, h) * 255),
      clampChannel(hueToRgb(p, q, h - 1 / 3) * 255),
    ],
    alpha,
  };
}

/** Parse a CSS color; throws if the value cannot be turned into sRGB. Alpha composites over `compositeOver` or throws. */
export function parseCssColor(
  color: string,
  compositeOver?: [number, number, number],
): [number, number, number] {
  const value = color.trim().toLowerCase();
  if (value === "transparent") {
    throw new Error(`Cannot compute contrast against transparent (${color})`);
  }
  const hex = parseHex(value);
  if (hex) return applyAlpha(hex.rgb, hex.alpha, color, compositeOver);
  const rgb = parseRgbFunction(value);
  if (rgb) return applyAlpha(rgb.rgb, rgb.alpha, color, compositeOver);
  const hsl = parseHslFunction(value);
  if (hsl) return applyAlpha(hsl.rgb, hsl.alpha, color, compositeOver);
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
