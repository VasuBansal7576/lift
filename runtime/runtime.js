/**
 * Declarative patch runtime. Fail-open: invalid specs and thrown ops leave the page as it was.
 * Keep allowlists in sync with shared/patch-spec.ts.
 */

const PATCH_SPEC_VERSION = 0;
const PATCH_OPS = new Set([
  "setAttribute",
  "setText",
  "injectCSS",
  "wrapLabel",
  "makeFocusable",
  "bindEnterToClick",
  "replaceTag",
  "insertHTML",
]);
const INSERT_HTML_POSITIONS = new Set(["before", "after", "prepend", "append"]);
const ALLOWED_REPLACE_TAGS = new Set(["button", "label", "span", "a", "p", "strong", "em"]);
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

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function isAllowedAttributeName(name) {
  if (typeof name !== "string") return false;
  if (name.toLowerCase().startsWith("on")) return false;
  if (ALLOWED_ATTR_NAMES.has(name)) return true;
  if (/^aria-[a-z0-9-]+$/.test(name)) return true;
  if (/^data-lift-[a-z0-9-]+$/.test(name)) return true;
  return false;
}

export function isSafeAttributeValue(name, value) {
  if (typeof value !== "string") return false;
  if (/[\u0000-\u001F\u007F]/.test(value)) return false;
  if (/^\s*javascript:/i.test(value)) return false;
  if (name === "href") return value.startsWith("#") || value.startsWith("/");
  return true;
}

export function isSafeInsertHtml(html) {
  if (typeof html !== "string") return false;
  if (/<\s*(script|iframe|object|embed|link|meta|style|form)\b/i.test(html)) return false;
  if (/\bon[a-z]+\s*=/i.test(html)) return false;
  if (/javascript:/i.test(html)) return false;
  return true;
}

function parseAttributes(raw) {
  if (raw === undefined) return {};
  if (!isRecord(raw)) return { error: "attributes must be an object" };
  const out = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isAllowedAttributeName(name)) return { error: `disallowed attribute: ${name}` };
    if (typeof value !== "string") return { error: `attribute ${name} must be a string` };
    if (!isSafeAttributeValue(name, value)) return { error: `unsafe attribute value: ${name}` };
    out[name] = value;
  }
  return out;
}

function parseOp(raw, index) {
  if (!isRecord(raw)) return { error: `ops[${index}] must be an object` };
  const op = raw.op;
  if (typeof op !== "string" || !PATCH_OPS.has(op)) {
    return { error: `ops[${index}] unknown op: ${String(op)}` };
  }
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
      if (/<\/\s*style/i.test(raw.css)) return { error: `ops[${index}] css must not close a style tag` };
      if (raw.id !== undefined && !isNonEmptyString(raw.id)) return { error: `ops[${index}] id must be a string` };
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
      if (typeof raw.tag !== "string" || !ALLOWED_REPLACE_TAGS.has(raw.tag)) {
        return { error: `ops[${index}] tag is not allowlisted` };
      }
      const attributes = parseAttributes(raw.attributes);
      if (attributes.error) return { error: `ops[${index}] ${attributes.error}` };
      return Object.keys(attributes).length > 0
        ? { op, selector: raw.selector, tag: raw.tag, attributes }
        : { op, selector: raw.selector, tag: raw.tag };
    }
    case "insertHTML": {
      if (!isNonEmptyString(raw.selector)) return { error: `ops[${index}] selector required` };
      if (typeof raw.position !== "string" || !INSERT_HTML_POSITIONS.has(raw.position)) {
        return { error: `ops[${index}] position must be before|after|prepend|append` };
      }
      if (!isNonEmptyString(raw.html) || !isSafeInsertHtml(raw.html)) {
        return { error: `ops[${index}] html is not allowlisted` };
      }
      if (raw.mountId !== undefined && !isNonEmptyString(raw.mountId)) {
        return { error: `ops[${index}] mountId must be a string` };
      }
      return raw.mountId === undefined
        ? { op, selector: raw.selector, position: raw.position, html: raw.html }
        : { op, selector: raw.selector, position: raw.position, html: raw.html, mountId: raw.mountId };
    }
    default:
      return { error: `ops[${index}] unknown op: ${op}` };
  }
}

export function validatePatchSpec(input) {
  if (!isRecord(input)) return { ok: false, error: "spec must be an object" };
  if (!isNonEmptyString(input.id)) return { ok: false, error: "id required" };
  if (input.version !== PATCH_SPEC_VERSION) {
    return { ok: false, error: `unsupported version: ${String(input.version)}` };
  }
  if (!Array.isArray(input.ops)) return { ok: false, error: "ops must be an array" };
  const ops = [];
  for (let i = 0; i < input.ops.length; i++) {
    const parsed = parseOp(input.ops[i], i);
    if (parsed.error) return { ok: false, error: parsed.error };
    ops.push(parsed);
  }
  return { ok: true, spec: { id: input.id, version: PATCH_SPEC_VERSION, ops } };
}

function docOf(root) {
  return root.nodeType === 9 ? root : root.ownerDocument;
}

function queryOne(root, selector) {
  try {
    return root.querySelector(selector);
  } catch {
    return null;
  }
}

function cssKey(op) {
  if (op.id) return `lift-patch-css-${op.id}`;
  let hash = 0;
  for (let i = 0; i < op.css.length; i++) hash = (Math.imul(31, hash) + op.css.charCodeAt(i)) | 0;
  return `lift-patch-css-${hash >>> 0}`;
}

function applySetAttribute(root, op) {
  const el = queryOne(root, op.selector);
  if (!(el instanceof Element)) return null;
  if (el.getAttribute(op.name) === op.value) return null;
  const had = el.hasAttribute(op.name);
  const prev = el.getAttribute(op.name);
  el.setAttribute(op.name, op.value);
  return () => {
    if (!had) el.removeAttribute(op.name);
    else el.setAttribute(op.name, prev ?? "");
  };
}

function applySetText(root, op) {
  const el = queryOne(root, op.selector);
  if (!(el instanceof Element)) return null;
  const prev = el.textContent ?? "";
  if (prev === op.text) return null;
  el.textContent = op.text;
  return () => {
    el.textContent = prev;
  };
}

function applyInjectCss(root, op) {
  const doc = docOf(root);
  const id = cssKey(op);
  if (doc.getElementById(id)) return null;
  const style = doc.createElement("style");
  style.id = id;
  style.setAttribute("data-lift-css", "1");
  style.textContent = op.css;
  const parent = doc.head ?? doc.documentElement;
  parent.appendChild(style);
  return () => {
    style.remove();
  };
}

function applyWrapLabel(root, op) {
  const input = queryOne(root, op.selector);
  if (!(input instanceof Element)) return null;
  if (input.getAttribute("data-labelled") === "1") return null;
  const id = input.id;
  if (!id) return null;
  const doc = docOf(root);
  const label = doc.createElement("label");
  label.setAttribute("for", id);
  label.textContent = op.text;
  const hint = input.parentElement?.querySelector(".visible-hint") ?? null;
  const prevLabelled = input.getAttribute("data-labelled");
  const hadUnlabeled = input.hasAttribute("data-unlabeled");
  input.removeAttribute("data-unlabeled");
  input.setAttribute("data-labelled", "1");
  if (hint) hint.replaceWith(label);
  else input.insertAdjacentElement("beforebegin", label);
  return () => {
    if (hint) label.replaceWith(hint);
    else label.remove();
    if (prevLabelled == null) input.removeAttribute("data-labelled");
    else input.setAttribute("data-labelled", prevLabelled);
    if (hadUnlabeled) input.setAttribute("data-unlabeled", "");
  };
}

function applyMakeFocusable(root, op) {
  const el = queryOne(root, op.selector);
  if (!(el instanceof HTMLElement)) return null;
  if (el.getAttribute("data-lift-focusable") === "1") return null;
  const hadTab = el.hasAttribute("tabindex");
  const prevTab = el.getAttribute("tabindex");
  el.tabIndex = 0;
  el.setAttribute("data-lift-focusable", "1");
  return () => {
    el.removeAttribute("data-lift-focusable");
    if (!hadTab) el.removeAttribute("tabindex");
    else el.setAttribute("tabindex", prevTab ?? "0");
  };
}

function applyBindEnterToClick(root, op) {
  const el = queryOne(root, op.selector);
  if (!(el instanceof HTMLElement)) return null;
  if (el.getAttribute("data-lift-enter") === "1") return null;
  const onKey = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      el.click();
    }
  };
  el.addEventListener("keydown", onKey);
  el.setAttribute("data-lift-enter", "1");
  return () => {
    el.removeEventListener("keydown", onKey);
    el.removeAttribute("data-lift-enter");
  };
}

function copySafeAttributes(from, to) {
  for (const attr of [...from.attributes]) {
    if (attr.name === "id" || attr.name === "class") continue;
    if (!isAllowedAttributeName(attr.name)) continue;
    if (!isSafeAttributeValue(attr.name, attr.value)) continue;
    to.setAttribute(attr.name, attr.value);
  }
}

function applyReplaceTag(root, op) {
  const el = queryOne(root, op.selector);
  if (!(el instanceof Element)) return null;
  if (el.tagName.toLowerCase() === op.tag.toLowerCase()) {
    const attrs = op.attributes || {};
    const undoAttrs = [];
    for (const [name, value] of Object.entries(attrs)) {
      if (el.getAttribute(name) === value) continue;
      const had = el.hasAttribute(name);
      const prev = el.getAttribute(name);
      el.setAttribute(name, value);
      undoAttrs.push(() => {
        if (!had) el.removeAttribute(name);
        else el.setAttribute(name, prev ?? "");
      });
    }
    if (undoAttrs.length === 0) return null;
    return () => {
      for (const undo of undoAttrs.reverse()) undo();
    };
  }
  const doc = docOf(root);
  const next = doc.createElement(op.tag);
  if (el.id) next.id = el.id;
  if (el.className && typeof el.className === "string") next.className = el.className;
  next.textContent = el.textContent ?? "";
  copySafeAttributes(el, next);
  for (const [name, value] of Object.entries(op.attributes || {})) {
    next.setAttribute(name, value);
  }
  el.replaceWith(next);
  return () => {
    next.replaceWith(el);
  };
}

function applyInsertHtml(root, op) {
  const doc = docOf(root);
  if (op.mountId) {
    const existing = queryOne(root, `[data-lift-mount="${op.mountId}"]`);
    if (existing) return null;
  }
  const target = queryOne(root, op.selector);
  if (!(target instanceof Element)) return null;
  if (!isSafeInsertHtml(op.html)) return null;
  const holder = doc.createElement("span");
  holder.setAttribute("data-lift-mount", op.mountId || "lift-html");
  holder.setAttribute("data-lift-inserted", "1");
  holder.innerHTML = op.html;
  switch (op.position) {
    case "before":
      target.before(holder);
      break;
    case "after":
      target.after(holder);
      break;
    case "prepend":
      target.prepend(holder);
      break;
    case "append":
      target.append(holder);
      break;
    default:
      return null;
  }
  return () => {
    holder.remove();
  };
}

function applyOp(root, op) {
  switch (op.op) {
    case "setAttribute":
      return applySetAttribute(root, op);
    case "setText":
      return applySetText(root, op);
    case "injectCSS":
      return applyInjectCss(root, op);
    case "wrapLabel":
      return applyWrapLabel(root, op);
    case "makeFocusable":
      return applyMakeFocusable(root, op);
    case "bindEnterToClick":
      return applyBindEnterToClick(root, op);
    case "replaceTag":
      return applyReplaceTag(root, op);
    case "insertHTML":
      return applyInsertHtml(root, op);
    default:
      return null;
  }
}

/** Apply a validated spec. On any throw, undo applied ops so the page is untouched. */
export function applyPatchSpec(input, root) {
  try {
    const parsed = validatePatchSpec(input);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const scope = root ?? (typeof document === "undefined" ? null : document);
    if (!scope) return { ok: false, error: "no document" };
    const undos = [];
    try {
      for (const op of parsed.spec.ops) {
        const undo = applyOp(scope, op);
        if (undo) undos.push(undo);
      }
      return { ok: true };
    } catch (err) {
      for (const undo of undos.reverse()) {
        try {
          undo();
        } catch {
          /* fail-open: best-effort undo */
        }
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

if (typeof window !== "undefined") {
  window.LiftRuntime = { applyPatchSpec, validatePatchSpec };
}
