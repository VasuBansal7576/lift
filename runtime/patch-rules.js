/**
 * Allowlists and parsers shared by the browser runtime and the TypeScript wrapper.
 * Keep this file free of Node-only imports so `/runtime/runtime.js` can import it.
 */

export const PATCH_SPEC_VERSION = 0;
export const PATCH_OPS = [
  "setAttribute",
  "setText",
  "injectCSS",
  "wrapLabel",
  "makeFocusable",
  "bindEnterToClick",
  "replaceTag",
  "insertHTML",
];
export const INSERT_HTML_POSITIONS = ["before", "after", "prepend", "append"];
export const ALLOWED_REPLACE_TAGS = ["button", "label", "span", "a", "p", "strong", "em"];
export const MOUNT_ID_RE = /^[a-z0-9_-]+$/i;
export const INSERT_TAGS = new Set([
  "a",
  "span",
  "strong",
  "em",
  "p",
  "button",
  "label",
  "b",
  "i",
  "small",
  "br",
]);

const ALLOWED_ATTR_NAMES = new Set([
  "class",
  "for",
  "type",
  "tabindex",
  "role",
  "alt",
  "lang",
  "autocomplete",
  "title",
  "aria-expanded",
  "aria-controls",
  "aria-label",
  "aria-labelledby",
  "aria-describedby",
  "aria-hidden",
  "href",
]);

const PATCH_OP_SET = new Set(PATCH_OPS);
const INSERT_POS_SET = new Set(INSERT_HTML_POSITIONS);
const REPLACE_TAG_SET = new Set(ALLOWED_REPLACE_TAGS);
const DROP_INSERT_ATTR = new Set([
  "src",
  "srcset",
  "formaction",
  "action",
  "poster",
  "cite",
  "background",
  "style",
  "data",
  "codebase",
  "id",
  "name",
]);

const HTML_NS = "http://www.w3.org/1999/xhtml";

const FORBIDDEN_OP_HOSTS = new Set([
  "html",
  "head",
  "body",
  "form",
  "input",
  "select",
  "textarea",
  "script",
  "style",
  "template",
  "iframe",
  "svg",
  "noscript",
]);

const VOID_OR_CONTROL = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
  "select",
  "textarea",
  "button",
  "option",
  "optgroup",
  "datalist",
  "output",
  "progress",
  "meter",
  "fieldset",
  "form",
]);

const FORBIDDEN_CSS_TYPES = new Set(["html", "body", "head"]);

const ALLOWED_CSS_PSEUDO = new Set([
  "focus",
  "focus-visible",
  "focus-within",
  "hover",
  "active",
  "disabled",
  "checked",
]);

const ALLOWED_CSS_PSEUDO_EL = new Set(["placeholder"]);

const COLOR_PROPS = new Set([
  "color",
  "background-color",
  "outline-color",
  "border-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "text-decoration-color",
]);

const BOX_PROPS = new Set([
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
]);

const SIZE_PROPS = new Set(["width", "height", "min-width", "min-height", "max-width", "max-height"]);

const ALLOWED_CSS_PROPS = new Set([
  "color",
  "background-color",
  "outline",
  "outline-color",
  "outline-style",
  "outline-width",
  "outline-offset",
  "border",
  "border-color",
  "border-style",
  "border-width",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-decoration",
  "text-decoration-line",
  "text-decoration-color",
  "text-decoration-style",
  "text-decoration-thickness",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "display",
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "opacity",
  "animation",
  "transition",
  "position",
]);

const ALLOWED_DISPLAY = new Set([
  "block",
  "inline",
  "inline-block",
  "flex",
  "inline-flex",
  "grid",
  "inline-grid",
  "contents",
  "list-item",
  "table",
  "table-row",
  "table-cell",
  "inline-table",
  "flow-root",
]);

const ALLOWED_CSS_FUNCS = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "clamp",
  "min",
  "max",
  "inset",
  "circle",
  "ellipse",
  "polygon",
  "rect",
  "calc",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function isSafeMountId(value) {
  return typeof value === "string" && MOUNT_ID_RE.test(value);
}

export function isAllowedAttributeName(name) {
  if (typeof name !== "string") return false;
  const lower = name.toLowerCase();
  if (lower.startsWith("on")) return false;
  if (lower.startsWith("data-lift-")) return false;
  if (ALLOWED_ATTR_NAMES.has(lower)) return true;
  if (/^aria-[a-z0-9-]+$/.test(lower)) return true;
  return false;
}

/** Same-origin href: `#…` or a single `/` not followed by `/` or `\`. */
export function isSafeHref(value) {
  if (typeof value !== "string") return false;
  if (/[\u0000-\u001F\u007F]/.test(value)) return false;
  const trimmed = value.trim();
  if (/^\s*javascript:/i.test(trimmed)) return false;
  if (trimmed.startsWith("#")) return !trimmed.includes("\\");
  if (trimmed.startsWith("/") && !trimmed.startsWith("//") && !trimmed.startsWith("/\\")) {
    return !trimmed.includes("\\");
  }
  return false;
}

export function isSafeAttributeValue(name, value) {
  if (typeof value !== "string") return false;
  if (/[\u0000-\u001F\u007F]/.test(value)) return false;
  if (/^\s*javascript:/i.test(value)) return false;
  if (name.toLowerCase() === "href") return isSafeHref(value);
  return true;
}

export function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

function replacementChar(code) {
  if (!Number.isFinite(code) || code === 0 || code > 0x10ffff) return "\uFFFD";
  if (code >= 0xd800 && code <= 0xdfff) return "\uFFFD";
  return String.fromCodePoint(code);
}

export function decodeCssEscapes(css) {
  return css.replace(/\\([0-9a-fA-F]{1,6})(?:\r\n|[ \t\r\n\f])?|\\(.)/g, (_, hex, ch) => {
    if (hex) return replacementChar(parseInt(hex, 16));
    return ch;
  });
}

function cssHasForbiddenTokens(text) {
  if (/<\/\s*style/i.test(text)) return true;
  if (/@/.test(text)) return true;
  if (/\b(?:url|src|image-set|image|element|paint|expression)\s*\(/i.test(text)) return true;
  return false;
}

function isAllowedCompound(compound) {
  if (!compound) return false;
  let i = 0;
  let anchored = false;
  const type = compound.match(/^[a-zA-Z_][\w-]*/);
  if (type) {
    const name = type[0].toLowerCase();
    if (FORBIDDEN_CSS_TYPES.has(name) || FORBIDDEN_OP_HOSTS.has(name)) return false;
    anchored = true;
    i = type[0].length;
  }
  while (i < compound.length) {
    const rest = compound.slice(i);
    const cls = rest.match(/^\.[a-zA-Z_][\w-]*/);
    if (cls) {
      anchored = true;
      i += cls[0].length;
      continue;
    }
    const id = rest.match(/^#[a-zA-Z_][\w-]*/);
    if (id) {
      anchored = true;
      i += id[0].length;
      continue;
    }
    const attr = rest.match(/^\[[a-zA-Z_][\w-]*(?:=[a-zA-Z_][\w-]*)?\]/);
    if (attr) {
      if (!anchored) return false;
      i += attr[0].length;
      continue;
    }
    const pseudoEl = rest.match(/^::([a-zA-Z_][\w-]*)/);
    if (pseudoEl) {
      if (!ALLOWED_CSS_PSEUDO_EL.has(pseudoEl[1].toLowerCase())) return false;
      i += pseudoEl[0].length;
      continue;
    }
    const pseudo = rest.match(/^:([a-zA-Z_][\w-]*)/);
    if (pseudo) {
      if (!ALLOWED_CSS_PSEUDO.has(pseudo[1].toLowerCase())) return false;
      i += pseudo[0].length;
      continue;
    }
    return false;
  }
  return anchored;
}

function isAllowedSelectorList(selectorList) {
  if (selectorList.includes("*") || selectorList.includes("|") || /[()]/.test(selectorList)) {
    return false;
  }
  for (const raw of selectorList.split(",")) {
    const selector = raw.trim();
    if (!selector) return false;
    const compounds = selector.split(/\s*[>+~]\s*|\s+/);
    if (compounds.some((part) => !isAllowedCompound(part))) return false;
  }
  return true;
}

function cssFunctionsAllowed(value) {
  const funcs = value.match(/-?[a-zA-Z_][\w-]*\s*\(/g) ?? [];
  for (const raw of funcs) {
    const name = raw.replace(/\s*\($/, "").toLowerCase();
    if (!ALLOWED_CSS_FUNCS.has(name)) return false;
  }
  return true;
}

function isNonNegPx(token, max) {
  if (token === "0") return true;
  const match = token.match(/^(\d+(?:\.\d+)?)px$/i);
  if (!match) return false;
  const n = Number(match[1]);
  return n >= 0 && n <= max;
}

function isSafeMarginPadding(value) {
  const parts = value.trim().split(/\s+/);
  if (parts.length < 1 || parts.length > 4) return false;
  return parts.every((part) => isNonNegPx(part, 64));
}

function isSafeSize(value) {
  const v = value.trim().toLowerCase();
  if (v === "0" || v === "auto") return true;
  const px = v.match(/^(\d+(?:\.\d+)?)px$/);
  if (px) return Number(px[1]) >= 0 && Number(px[1]) <= 1200;
  const pct = v.match(/^(\d+(?:\.\d+)?)%$/);
  if (pct) return Number(pct[1]) >= 0 && Number(pct[1]) <= 100;
  return false;
}

function isSafeFontSize(value) {
  const v = value.trim().toLowerCase();
  const px = v.match(/^(\d+(?:\.\d+)?)px$/);
  if (px) {
    const n = Number(px[1]);
    return n >= 10 && n <= 48;
  }
  const em = v.match(/^(\d+(?:\.\d+)?)(em|rem)$/);
  if (em) {
    const n = Number(em[1]);
    return n >= 0.75 && n <= 3;
  }
  return false;
}

function isSafeLineHeight(value) {
  const v = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(v)) return false;
  const n = Number(v);
  return n >= 1 && n <= 3;
}

function isTransparentColor(value) {
  const v = value.trim().toLowerCase();
  if (v === "transparent") return true;
  if (/^#(?:0000|00000000)$/.test(v)) return true;
  if (/^rgba?\(\s*0(?:\.0+)?\s*,\s*0(?:\.0+)?\s*,\s*0(?:\.0+)?\s*(?:,\s*0(?:\.0+)?\s*)?\)$/.test(v)) {
    return true;
  }
  return false;
}

function isSafeCssValue(prop, value) {
  if (!value) return false;
  if (!cssFunctionsAllowed(value)) return false;
  const v = value.trim();
  if (COLOR_PROPS.has(prop) && isTransparentColor(v)) return false;
  if (prop === "display") return ALLOWED_DISPLAY.has(v.toLowerCase());
  if (prop === "position") return /^(static|relative)$/i.test(v);
  if (prop === "animation" || prop === "transition") return /^none$/i.test(v);
  if (prop === "opacity") {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0.5 && n <= 1;
  }
  if (prop === "font-size") return isSafeFontSize(v);
  if (prop === "line-height") return isSafeLineHeight(v);
  if (BOX_PROPS.has(prop)) return isSafeMarginPadding(v);
  if (SIZE_PROPS.has(prop)) return isSafeSize(v);
  if (prop === "letter-spacing" || prop === "word-spacing") {
    return v.toLowerCase() === "normal" || isNonNegPx(v, 64);
  }
  return true;
}

function isSafeDeclarationBlock(body) {
  for (const part of body.split(";")) {
    const decl = part.trim();
    if (!decl) continue;
    const colon = decl.indexOf(":");
    if (colon < 1) return false;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl
      .slice(colon + 1)
      .trim()
      .replace(/\s*!important$/i, "")
      .trim();
    if (!ALLOWED_CSS_PROPS.has(prop)) return false;
    if (!isSafeCssValue(prop, value)) return false;
  }
  return true;
}

/** Small CSS grammar: no strings, comments stripped, escapes decoded, allowlisted props/selectors. */
export function isSafeCss(css) {
  try {
    if (typeof css !== "string" || css.length === 0) return false;
    if (/["']/.test(css)) return false;
    if (/\\[\r\n]/.test(css)) return false;
    if (cssHasForbiddenTokens(css)) return false;
    const stripped = stripCssComments(css);
    if (cssHasForbiddenTokens(stripped)) return false;
    const decoded = decodeCssEscapes(stripped);
    if (decoded.includes("\uFFFD") || decoded.includes("\u0000")) return false;
    if (/["']/.test(decoded)) return false;
    if (cssHasForbiddenTokens(decoded)) return false;
    let ok = true;
    const leftover = decoded.replace(/([^{}]+)\{([^{}]*)\}/g, (_, selector, body) => {
      if (!isAllowedSelectorList(selector) || !isSafeDeclarationBlock(body)) ok = false;
      return " ";
    });
    if (!ok) return false;
    return leftover.trim().length === 0;
  } catch {
    return false;
  }
}

function selectorTypeIsForbiddenHost(selector) {
  for (const raw of selector.split(",")) {
    const compounds = raw.trim().split(/\s*[>+~]\s*|\s+/);
    for (const compound of compounds) {
      const type = compound.match(/^[a-zA-Z_][\w-]*/);
      if (type && FORBIDDEN_OP_HOSTS.has(type[0].toLowerCase())) return true;
    }
  }
  return false;
}

export function selectorTargetsForbiddenHost(selector) {
  if (typeof selector !== "string" || selector.length === 0) return true;
  return selectorTypeIsForbiddenHost(selector);
}

export function selectorTargetsForbiddenTextHost(selector) {
  return selectorTargetsForbiddenHost(selector);
}

export function localTagName(el) {
  return String(el.localName || el.tagName || "").toLowerCase();
}

export function isHtmlNamespace(el) {
  const ns = el.namespaceURI;
  return !ns || ns === HTML_NS;
}

export function elementForbiddenAsTextOrTagHost(el) {
  if (!el || el.nodeType !== 1) return true;
  if (!isHtmlNamespace(el)) return true;
  return FORBIDDEN_OP_HOSTS.has(localTagName(el));
}

export function elementHasVoidOrControlDescendant(el) {
  if (!el || typeof el.querySelectorAll !== "function") return true;
  for (const child of el.querySelectorAll("*")) {
    if (!isHtmlNamespace(child)) return true;
    if (VOID_OR_CONTROL.has(localTagName(child))) return true;
  }
  return false;
}

export function hashKey(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0;
  return String(hash >>> 0);
}

export function cssKey(op) {
  if (op.id) return `lift-patch-css-${op.id}`;
  return `lift-patch-css-${hashKey(op.css)}`;
}

export function mountKeyFor(op) {
  if (op.mountId) return op.mountId;
  return `m${hashKey(`${op.position}|${op.selector}|${op.html}`)}`;
}

function resolveDoc(doc) {
  if (doc) return doc;
  if (typeof document !== "undefined") return document;
  return null;
}

function insertAttrForbidden(name) {
  const n = name.toLowerCase();
  if (n.startsWith("on")) return true;
  if (n.startsWith("data-lift-")) return true;
  if (n.includes(":")) return true;
  if (DROP_INSERT_ATTR.has(n)) return true;
  return false;
}

function sanitizeInsertedElement(el) {
  const tag = localTagName(el);
  if (!INSERT_TAGS.has(tag)) return false;
  if (tag === "button") {
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (!type) el.setAttribute("type", "button");
    else if (type !== "button") return false;
  }
  for (const attr of [...el.attributes]) {
    const name = attr.name;
    if (insertAttrForbidden(name)) return false;
    if (name.toLowerCase() === "href") {
      if (!isSafeHref(attr.value)) return false;
      continue;
    }
    if (!isAllowedAttributeName(name) || !isSafeAttributeValue(name, attr.value)) return false;
  }
  for (const child of [...el.childNodes]) {
    if (child.nodeType === 8) {
      child.remove();
      continue;
    }
    if (child.nodeType === 3) continue;
    if (child.nodeType !== 1) return false;
    if (!sanitizeInsertedElement(child)) return false;
  }
  return true;
}

/** Parse html into a template and keep only allowlisted elements/attrs. Returns a fragment or null. */
export function sanitizeInsertHtml(html, doc) {
  if (typeof html !== "string" || html.length === 0) return null;
  const documentRef = resolveDoc(doc);
  if (!documentRef) return null;
  const template = documentRef.createElement("template");
  try {
    template.innerHTML = html;
  } catch {
    return null;
  }
  const fragment = template.content;
  for (const node of [...fragment.childNodes]) {
    if (node.nodeType === 8) {
      node.remove();
      continue;
    }
    if (node.nodeType === 3) continue;
    if (node.nodeType !== 1) return null;
    if (!sanitizeInsertedElement(node)) return null;
  }
  return fragment;
}

export function isSafeInsertHtml(html, doc) {
  return sanitizeInsertHtml(html, doc) !== null;
}

function parseAttributes(raw, index) {
  if (raw === undefined) return {};
  if (!isRecord(raw)) return { error: `ops[${index}] attributes must be an object` };
  const out = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isAllowedAttributeName(name)) return { error: `ops[${index}] disallowed attribute: ${name}` };
    if (typeof value !== "string") return { error: `ops[${index}] attribute ${name} must be a string` };
    if (!isSafeAttributeValue(name, value)) return { error: `ops[${index}] unsafe attribute value: ${name}` };
    out[name] = value;
  }
  return out;
}

function parseOp(raw, index, doc) {
  if (!isRecord(raw)) return { error: `ops[${index}] must be an object` };
  const op = raw.op;
  if (typeof op !== "string") return { error: `ops[${index}] missing op` };
  if (!PATCH_OP_SET.has(op)) return { error: `ops[${index}] unknown op: ${op}` };
  switch (op) {
    case "setAttribute": {
      if (!isNonEmptyString(raw.selector)) return { error: `ops[${index}] selector required` };
      if (!isNonEmptyString(raw.name)) return { error: `ops[${index}] name required` };
      if (typeof raw.value !== "string") return { error: `ops[${index}] value must be a string` };
      if (raw.name.toLowerCase() === "type") return { error: `ops[${index}] disallowed attribute` };
      if (!isAllowedAttributeName(raw.name)) return { error: `ops[${index}] disallowed attribute` };
      if (!isSafeAttributeValue(raw.name, raw.value)) {
        return { error: `ops[${index}] unsafe attribute value` };
      }
      return { op, selector: raw.selector, name: raw.name, value: raw.value };
    }
    case "setText": {
      if (!isNonEmptyString(raw.selector)) return { error: `ops[${index}] selector required` };
      if (typeof raw.text !== "string") return { error: `ops[${index}] text must be a string` };
      if (selectorTargetsForbiddenHost(raw.selector)) {
        return { error: `ops[${index}] target is not allowlisted` };
      }
      return { op, selector: raw.selector, text: raw.text };
    }
    case "injectCSS": {
      if (!isNonEmptyString(raw.css)) return { error: `ops[${index}] css required` };
      if (!isSafeCss(raw.css)) return { error: `ops[${index}] css is not allowlisted` };
      if (raw.id !== undefined && !isSafeMountId(raw.id)) {
        return { error: `ops[${index}] id is invalid` };
      }
      return raw.id === undefined ? { op, css: raw.css } : { op, css: raw.css, id: raw.id };
    }
    case "wrapLabel": {
      if (!isNonEmptyString(raw.selector)) return { error: `ops[${index}] selector required` };
      if (!isNonEmptyString(raw.text)) return { error: `ops[${index}] text required` };
      return { op, selector: raw.selector, text: raw.text };
    }
    case "makeFocusable":
    case "bindEnterToClick": {
      if (!isNonEmptyString(raw.selector)) return { error: `ops[${index}] selector required` };
      return { op, selector: raw.selector };
    }
    case "replaceTag": {
      if (!isNonEmptyString(raw.selector)) return { error: `ops[${index}] selector required` };
      if (typeof raw.tag !== "string" || !REPLACE_TAG_SET.has(raw.tag)) {
        return { error: `ops[${index}] tag is not allowlisted` };
      }
      if (selectorTargetsForbiddenHost(raw.selector)) {
        return { error: `ops[${index}] target is not allowlisted` };
      }
      const attributes = parseAttributes(raw.attributes, index);
      if (attributes.error) return { error: attributes.error };
      if (raw.tag === "a") {
        if (typeof attributes.href !== "string" || !isSafeHref(attributes.href)) {
          return { error: `ops[${index}] a requires href` };
        }
      }
      return Object.keys(attributes).length > 0
        ? { op, selector: raw.selector, tag: raw.tag, attributes }
        : { op, selector: raw.selector, tag: raw.tag };
    }
    case "insertHTML": {
      if (!isNonEmptyString(raw.selector)) return { error: `ops[${index}] selector required` };
      if (typeof raw.position !== "string" || !INSERT_POS_SET.has(raw.position)) {
        return { error: `ops[${index}] position must be before|after|prepend|append` };
      }
      if (typeof raw.html !== "string" || raw.html.length === 0) {
        return { error: `ops[${index}] html required` };
      }
      if (!isSafeInsertHtml(raw.html, doc)) return { error: `ops[${index}] html is not allowlisted` };
      if (raw.mountId !== undefined && !isSafeMountId(raw.mountId)) {
        return { error: `ops[${index}] mountId is invalid` };
      }
      return raw.mountId === undefined
        ? { op, selector: raw.selector, position: raw.position, html: raw.html }
        : { op, selector: raw.selector, position: raw.position, html: raw.html, mountId: raw.mountId };
    }
    default:
      return { error: `ops[${index}] unknown op: ${op}` };
  }
}

export function parsePatchSpec(input, doc) {
  try {
    if (!isRecord(input)) return { ok: false, error: "spec must be an object" };
    if (!isNonEmptyString(input.id)) return { ok: false, error: "id required" };
    if (input.version !== PATCH_SPEC_VERSION) {
      return { ok: false, error: `unsupported version: ${String(input.version)}` };
    }
    if (!Array.isArray(input.ops)) return { ok: false, error: "ops must be an array" };
    const ops = [];
    for (let i = 0; i < input.ops.length; i++) {
      const parsed = parseOp(input.ops[i], i, doc);
      if (parsed.error) return { ok: false, error: parsed.error };
      ops.push(parsed);
    }
    return { ok: true, spec: { id: input.id, version: PATCH_SPEC_VERSION, ops } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
