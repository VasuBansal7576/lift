/**
 * Allowlists and parsers shared by the browser runtime and the TypeScript wrapper.
 * Keep this file free of Node-only imports so `/runtime/runtime.js` can import it.
 */

import { parseCssRules } from "./css-typed.js";

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
  "toggleDisclosure",
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
export const PATCH_OP_LIMIT = 50;
export const CSS_MATCH_LIMIT = 50;

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
  "for",
]);

const HTML_NS = "http://www.w3.org/1999/xhtml";

export const FORBIDDEN_OP_HOSTS = new Set([
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

const PAGE_CONTAINERS = new Set(["html", "head", "body", "main", "header", "footer", "nav", "aside"]);

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

const INTERACTIVE_TAGS = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "iframe",
  "audio",
  "video",
  "object",
  "embed",
]);

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "tab",
  "checkbox",
  "radio",
  "textbox",
  "switch",
  "option",
  "combobox",
  "slider",
  "searchbox",
  "spinbutton",
  "menuitemcheckbox",
  "menuitemradio",
  "treeitem",
]);

const HIDDEN_ROLE_TOKENS = new Set(["none", "presentation"]);
const LABELABLE_INPUT_TYPES = new Set([
  "text",
  "email",
  "tel",
  "number",
  "search",
  "url",
  "password",
  "checkbox",
  "radio",
]);
const REFUSED_INPUT_TYPES = new Set(["button", "submit", "reset", "image", "hidden"]);

const OP_KEYS = {
  setAttribute: new Set(["op", "selector", "name", "value"]),
  setText: new Set(["op", "selector", "text"]),
  injectCSS: new Set(["op", "rules", "id"]),
  wrapLabel: new Set(["op", "selector", "text"]),
  makeFocusable: new Set(["op", "selector"]),
  bindEnterToClick: new Set(["op", "selector"]),
  replaceTag: new Set(["op", "selector", "tag", "attributes"]),
  insertHTML: new Set(["op", "selector", "position", "html", "mountId"]),
  toggleDisclosure: new Set(["op", "trigger", "panel"]),
};

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function extraKeys(raw, allowed) {
  return Object.keys(raw).filter((key) => !allowed.has(key));
}

export function isSafeMountId(value) {
  return typeof value === "string" && MOUNT_ID_RE.test(value) && value.length <= 64;
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

function roleTokens(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

export function isSafeAttributeValue(name, value) {
  if (typeof value !== "string") return false;
  if (/[\u0000-\u001F\u007F]/.test(value)) return false;
  if (/^\s*javascript:/i.test(value)) return false;
  const attr = name.toLowerCase();
  if (attr === "href") return isSafeHref(value);
  if (attr === "tabindex") {
    return value === "0" || value === "-1";
  }
  if (attr === "aria-hidden") {
    return value === "true" || value === "false";
  }
  if (attr === "role") {
    const tokens = roleTokens(value);
    if (tokens.length === 0) return false;
    return tokens.every((token) => !HIDDEN_ROLE_TOKENS.has(token));
  }
  return true;
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

export function elementIsPageContainer(el) {
  if (!el || el.nodeType !== 1) return true;
  return PAGE_CONTAINERS.has(localTagName(el));
}

export function elementHasVoidOrControlDescendant(el) {
  if (!el || typeof el.querySelectorAll !== "function") return true;
  for (const child of el.querySelectorAll("*")) {
    if (!isHtmlNamespace(child)) return true;
    if (VOID_OR_CONTROL.has(localTagName(child))) return true;
  }
  return false;
}

export function elementHasElementChildren(el) {
  if (!el || !el.childNodes) return true;
  for (const child of el.childNodes) {
    if (child.nodeType === 1) return true;
  }
  return false;
}

function isContentEditable(el) {
  if (!el || typeof el.getAttribute !== "function") return true;
  if (el.isContentEditable === true) return true;
  const raw = (el.getAttribute("contenteditable") || "").trim().toLowerCase();
  return raw === "" && el.hasAttribute("contenteditable") ? true : raw === "true" || raw === "plaintext-only";
}

export function isInteractiveElement(el) {
  if (!el || el.nodeType !== 1) return true;
  if (INTERACTIVE_TAGS.has(localTagName(el))) return true;
  if (el.hasAttribute("tabindex")) return true;
  if (isContentEditable(el)) return true;
  return roleTokens(el.getAttribute("role") || "").some((token) => INTERACTIVE_ROLES.has(token));
}

export function elementHasInteractiveDescendant(el) {
  if (!el || typeof el.querySelectorAll !== "function") return true;
  for (const child of el.querySelectorAll("*")) {
    if (isInteractiveElement(child)) return true;
  }
  return false;
}

export function attributeWouldHideInteractive(name, value, el) {
  const n = String(name).toLowerCase();
  const v = String(value).trim().toLowerCase();
  const interactive = isInteractiveElement(el) || elementHasInteractiveDescendant(el);
  if (n === "aria-hidden") {
    if (v !== "true" && v !== "false") return true;
    if (interactive && v !== "false") return true;
    return false;
  }
  if (n === "role") {
    if (roleTokens(value).some((token) => HIDDEN_ROLE_TOKENS.has(token))) return true;
    return false;
  }
  if (n === "tabindex") {
    if (v !== "0" && v !== "-1") return true;
    if (v === "-1" && interactive) return true;
    return false;
  }
  return false;
}

export function isLabelableTextControl(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = localTagName(el);
  if (tag === "textarea" || tag === "select") return true;
  if (tag !== "input") return false;
  const type = (el.getAttribute("type") || "text").trim().toLowerCase();
  if (REFUSED_INPUT_TYPES.has(type)) return false;
  return LABELABLE_INPUT_TYPES.has(type);
}

export function hashKey(value) {
  let h1 = 2166136261;
  let h2 = 16777619;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 ^= c + i + 1;
    h2 = Math.imul(h2, 2166136261) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
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

function rejectUnknownKeys(raw, index, allowed) {
  if (extraKeys(raw, allowed).length > 0) {
    return { error: `ops[${index}] unknown key` };
  }
  return null;
}

function parseOp(raw, index, doc) {
  if (!isRecord(raw)) return { error: `ops[${index}] must be an object` };
  const op = raw.op;
  if (typeof op !== "string") return { error: `ops[${index}] missing op` };
  if (!PATCH_OP_SET.has(op)) return { error: `ops[${index}] unknown op: ${op}` };
  const unknown = rejectUnknownKeys(raw, index, OP_KEYS[op]);
  if (unknown) return unknown;
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
      if (selectorTargetsForbiddenHost(raw.selector)) {
        return { error: `ops[${index}] target is not allowlisted` };
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
      const parsed = parseCssRules(raw.rules, index);
      if (parsed.error) return { error: parsed.error };
      if (raw.id !== undefined && !isSafeMountId(raw.id)) {
        return { error: `ops[${index}] id is invalid` };
      }
      return raw.id === undefined
        ? { op, rules: parsed.rules, css: parsed.css }
        : { op, rules: parsed.rules, css: parsed.css, id: raw.id };
    }
    case "wrapLabel": {
      if (!isNonEmptyString(raw.selector)) return { error: `ops[${index}] selector required` };
      if (!isNonEmptyString(raw.text)) return { error: `ops[${index}] text required` };
      for (const rawSel of raw.selector.split(",")) {
        const type = rawSel.trim().match(/^[a-zA-Z_][\w-]*/);
        if (
          type &&
          FORBIDDEN_OP_HOSTS.has(type[0].toLowerCase()) &&
          type[0].toLowerCase() !== "input" &&
          type[0].toLowerCase() !== "select" &&
          type[0].toLowerCase() !== "textarea"
        ) {
          return { error: `ops[${index}] target is not allowlisted` };
        }
      }
      return { op, selector: raw.selector, text: raw.text };
    }
    case "makeFocusable":
    case "bindEnterToClick": {
      if (!isNonEmptyString(raw.selector)) return { error: `ops[${index}] selector required` };
      if (selectorTargetsForbiddenHost(raw.selector)) {
        return { error: `ops[${index}] target is not allowlisted` };
      }
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
      if (selectorTargetsForbiddenHost(raw.selector)) {
        return { error: `ops[${index}] target is not allowlisted` };
      }
      return raw.mountId === undefined
        ? { op, selector: raw.selector, position: raw.position, html: raw.html }
        : { op, selector: raw.selector, position: raw.position, html: raw.html, mountId: raw.mountId };
    }
    case "toggleDisclosure": {
      if (!isNonEmptyString(raw.trigger)) return { error: `ops[${index}] trigger required` };
      if (!isNonEmptyString(raw.panel)) return { error: `ops[${index}] panel required` };
      if (selectorTargetsForbiddenHost(raw.trigger) || selectorTargetsForbiddenHost(raw.panel)) {
        return { error: `ops[${index}] target is not allowlisted` };
      }
      return { op, trigger: raw.trigger, panel: raw.panel };
    }
    default:
      return { error: `ops[${index}] unknown op: ${op}` };
  }
}

export function parsePatchSpec(input, doc) {
  try {
    if (!isRecord(input)) return { ok: false, error: "spec must be an object" };
    if (extraKeys(input, new Set(["id", "version", "ops"])).length > 0) {
      return { ok: false, error: "unknown key" };
    }
    if (!isNonEmptyString(input.id)) return { ok: false, error: "id required" };
    if (input.version !== PATCH_SPEC_VERSION) {
      return { ok: false, error: `unsupported version: ${String(input.version)}` };
    }
    if (!Array.isArray(input.ops)) return { ok: false, error: "ops must be an array" };
    if (input.ops.length > PATCH_OP_LIMIT) return { ok: false, error: "too many ops" };
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
