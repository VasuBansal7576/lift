/**
 * Typed injectCSS: specs carry structured rules; this module serializes CSS.
 * No free-text CSS, comments, escapes, !important, or shorthands.
 */

export const CSS_STATES = [
  "focus",
  "focus-visible",
  "focus-within",
  "hover",
  "active",
  "disabled",
  "checked",
];

export const CSS_RULE_LIMIT = 20;
export const CSS_DECL_LIMIT = 20;
export const CSS_IDENT_MAX = 64;

const STATE_SET = new Set(CSS_STATES);
const FORBIDDEN_TAGS = new Set(["html", "body", "head", "svg", "script", "style"]);
const IDENT_RE = /^[a-zA-Z_][\w-]*$/;
const TAG_RE = /^[a-z][a-z0-9-]*$/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cssEscapeIdent(ident) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(ident);
  return String(ident).replace(/[^\w-]/g, (ch) => `\\${ch.codePointAt(0).toString(16)} `);
}

export function emitCssNumber(n) {
  if (!Number.isFinite(n)) return null;
  const s = n.toFixed(6).replace(/\.?0+$/, "");
  if (/[eE]/.test(s)) return null;
  return s;
}

function parseColor(raw) {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  const hex3 = v.match(/^#([0-9a-fA-F]{3})$/);
  if (hex3) {
    const [r, g, b] = hex3[1].toLowerCase();
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  const hex6 = v.match(/^#([0-9a-fA-F]{6})$/);
  if (hex6) return `#${hex6[1].toLowerCase()}`;
  const rgb = v.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/);
  if (rgb) {
    const ch = rgb.slice(1, 4).map(Number);
    if (ch.some((n) => n > 255)) return null;
    return `rgb(${ch[0]}, ${ch[1]}, ${ch[2]})`;
  }
  return null;
}

export function cssColorToRgb(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = hex[1];
    return [
      Number.parseInt(n.slice(0, 2), 16),
      Number.parseInt(n.slice(2, 4), 16),
      Number.parseInt(n.slice(4, 6), 16),
    ];
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(v);
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
    if (alpha < 0.99) return null;
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  if (v === "transparent") return null;
  return null;
}

export function relativeLuminance(r, g, b) {
  const lin = [r, g, b].map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function contrastRatio(fg, bg) {
  const l1 = relativeLuminance(fg[0], fg[1], fg[2]);
  const l2 = relativeLuminance(bg[0], bg[1], bg[2]);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function parsePx(raw, min, max) {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)px$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (n < min || n > max) return null;
  const emitted = emitCssNumber(n);
  if (emitted == null) return null;
  return `${emitted}px`;
}

function parseEm(raw, min, max) {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)em$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (n < min || n > max) return null;
  const emitted = emitCssNumber(n);
  if (emitted == null) return null;
  return `${emitted}em`;
}

function parseRem(raw, min, max) {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)rem$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (n < min || n > max) return null;
  const emitted = emitCssNumber(n);
  if (emitted == null) return null;
  return `${emitted}rem`;
}

function parseKeyword(raw, allowed) {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return allowed.has(v) ? v : null;
}

function parseFontWeight(raw) {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 400 && raw <= 900 && raw % 100 === 0) {
    return String(raw);
  }
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "normal" || v === "bold") return v;
  if (/^[1-9]00$/.test(v)) {
    const n = Number(v);
    if (n >= 400 && n <= 900) return v;
  }
  return null;
}

function parseLineHeight(raw) {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw.trim())
        ? Number(raw.trim())
        : NaN;
  if (!Number.isFinite(n) || n < 1 || n > 3) return null;
  return emitCssNumber(n);
}

const BORDER_STYLES = new Set(["solid", "dashed", "dotted"]);
const DECORATION_LINES = new Set(["underline"]);
const CURSORS = new Set(["pointer", "default"]);

function extraKeys(raw, allowed) {
  return Object.keys(raw).filter((key) => !allowed.has(key));
}

function parseDeclaration(raw) {
  if (!isRecord(raw)) return null;
  if (extraKeys(raw, new Set(["property", "value"])).length > 0) return null;
  if (typeof raw.property !== "string") return null;
  const property = raw.property;
  const value = raw.value;
  let emitted = null;
  switch (property) {
    case "color":
    case "background-color":
    case "outline-color":
    case "border-color":
      emitted = parseColor(value);
      break;
    case "outline-style":
    case "border-style":
      emitted = parseKeyword(value, BORDER_STYLES);
      break;
    case "outline-width":
      emitted = parsePx(value, 1, 8);
      break;
    case "outline-offset":
      emitted = parsePx(value, 0, 8);
      break;
    case "border-width":
      emitted = parsePx(value, 0, 8);
      break;
    case "font-size":
      emitted = parsePx(value, 12, 48) || parseRem(value, 0.75, 3);
      break;
    case "font-weight":
      emitted = parseFontWeight(value);
      break;
    case "line-height":
      emitted = parseLineHeight(value);
      break;
    case "letter-spacing":
    case "word-spacing":
      emitted = parsePx(value, 0, 4) || parseEm(value, 0, 0.2);
      break;
    case "text-decoration-line":
      emitted = parseKeyword(value, DECORATION_LINES);
      break;
    case "text-decoration-thickness":
      emitted = parsePx(value, 1, 4);
      break;
    case "min-height":
    case "min-width":
      emitted = parsePx(value, 0, 64);
      break;
    case "padding":
      emitted = parsePx(value, 0, 24);
      break;
    case "cursor":
      emitted = parseKeyword(value, CURSORS);
      break;
    default:
      return null;
  }
  if (emitted == null) return null;
  return { property, value: emitted };
}

function parseSelector(raw) {
  if (!isRecord(raw)) return null;
  if (extraKeys(raw, new Set(["tag", "classes", "id", "state"])).length > 0) return null;
  const out = {};
  if (raw.tag !== undefined) {
    if (typeof raw.tag !== "string" || !TAG_RE.test(raw.tag)) return null;
    if (FORBIDDEN_TAGS.has(raw.tag)) return null;
    out.tag = raw.tag;
  }
  if (raw.classes !== undefined) {
    if (!Array.isArray(raw.classes) || raw.classes.length === 0) return null;
    for (const cls of raw.classes) {
      if (typeof cls !== "string" || !IDENT_RE.test(cls) || cls.length > CSS_IDENT_MAX) return null;
    }
    out.classes = [...raw.classes];
  }
  if (raw.id !== undefined) {
    if (typeof raw.id !== "string" || !IDENT_RE.test(raw.id) || raw.id.length > CSS_IDENT_MAX) {
      return null;
    }
    out.id = raw.id;
  }
  if (raw.state !== undefined) {
    if (typeof raw.state !== "string" || !STATE_SET.has(raw.state)) return null;
    out.state = raw.state;
  }
  if (!out.id && !(out.classes && out.classes.length > 0)) return null;
  return out;
}

export function serializeSelector(selector) {
  let css = "";
  if (selector.tag) css += cssEscapeIdent(selector.tag);
  if (selector.id) css += `#${cssEscapeIdent(selector.id)}`;
  if (selector.classes) {
    for (const cls of selector.classes) css += `.${cssEscapeIdent(cls)}`;
  }
  if (selector.state) css += `:${selector.state}`;
  return css;
}

export function serializeSelectorForQuery(selector) {
  const { state: _state, ...rest } = selector;
  return serializeSelector(rest);
}

export function serializeCss(rules) {
  return rules
    .map((rule) => {
      const body = rule.declarations.map((d) => `${d.property}: ${d.value}`).join("; ");
      return `${serializeSelector(rule.selector)} { ${body}; }`;
    })
    .join(" ");
}

function ruleHasLowContrast(declarations) {
  const color = declarations.find((d) => d.property === "color");
  const bg = declarations.find((d) => d.property === "background-color");
  if (!color || !bg) return false;
  const fg = cssColorToRgb(color.value);
  const back = cssColorToRgb(bg.value);
  if (!fg || !back) return true;
  return contrastRatio(fg, back) < 4.5;
}

export function parseCssRules(rawRules, index) {
  if (!Array.isArray(rawRules) || rawRules.length === 0) {
    return { error: `ops[${index}] rules required` };
  }
  if (rawRules.length > CSS_RULE_LIMIT) {
    return { error: `ops[${index}] css is not allowlisted` };
  }
  const rules = [];
  for (const raw of rawRules) {
    if (!isRecord(raw)) return { error: `ops[${index}] css is not allowlisted` };
    if (extraKeys(raw, new Set(["selector", "declarations"])).length > 0) {
      return { error: `ops[${index}] css is not allowlisted` };
    }
    const selector = parseSelector(raw.selector);
    if (!selector) return { error: `ops[${index}] css is not allowlisted` };
    if (!Array.isArray(raw.declarations) || raw.declarations.length === 0) {
      return { error: `ops[${index}] css is not allowlisted` };
    }
    if (raw.declarations.length > CSS_DECL_LIMIT) {
      return { error: `ops[${index}] css is not allowlisted` };
    }
    const declarations = [];
    for (const decl of raw.declarations) {
      const parsed = parseDeclaration(decl);
      if (!parsed) return { error: `ops[${index}] css is not allowlisted` };
      declarations.push(parsed);
    }
    if (ruleHasLowContrast(declarations)) {
      return { error: `ops[${index}] css is not allowlisted` };
    }
    rules.push({ selector, declarations });
  }
  return { rules, css: serializeCss(rules) };
}
