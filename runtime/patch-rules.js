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
  "id",
  "class",
  "for",
  "type",
  "tabindex",
  "role",
  "alt",
  "lang",
  "autocomplete",
  "name",
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
  if (name.toLowerCase().startsWith("on")) return false;
  if (ALLOWED_ATTR_NAMES.has(name)) return true;
  if (/^aria-[a-z0-9-]+$/.test(name)) return true;
  if (/^data-lift-[a-z0-9-]+$/.test(name)) return true;
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
  if (name === "href") return isSafeHref(value);
  return true;
}

export function isSafeCss(css) {
  if (typeof css !== "string" || css.length === 0) return false;
  if (/<\/\s*style/i.test(css)) return false;
  if (/@import/i.test(css)) return false;
  if (/url\s*\(/i.test(css)) return false;
  if (/expression\s*\(/i.test(css)) return false;
  if (/behavior\s*:/i.test(css)) return false;
  if (/-moz-binding/i.test(css)) return false;
  if (/position\s*:\s*(fixed|sticky)/i.test(css)) return false;
  return true;
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
  if (n.includes(":")) return true;
  if (DROP_INSERT_ATTR.has(n)) return true;
  return false;
}

function sanitizeInsertedElement(el) {
  const tag = el.tagName.toLowerCase();
  if (!INSERT_TAGS.has(tag)) return false;
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
      if (!isAllowedAttributeName(raw.name)) return { error: `ops[${index}] disallowed attribute` };
      if (!isSafeAttributeValue(raw.name, raw.value)) {
        return { error: `ops[${index}] unsafe attribute value` };
      }
      return { op, selector: raw.selector, name: raw.name, value: raw.value };
    }
    case "setText": {
      if (!isNonEmptyString(raw.selector)) return { error: `ops[${index}] selector required` };
      if (typeof raw.text !== "string") return { error: `ops[${index}] text must be a string` };
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
      const attributes = parseAttributes(raw.attributes, index);
      if (attributes.error) return { error: attributes.error };
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
}
