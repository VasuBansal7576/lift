/**
 * Declarative patch runtime. Fail-open: invalid specs and thrown/missed ops leave the page as it was.
 * Validation lives in ./patch-rules.js (shared with the TypeScript wrapper).
 */

import {
  contrastRatio,
  cssColorToRgb,
  serializeSelectorForQuery,
} from "./css-typed.js";
import {
  attributeWouldHideInteractive,
  CSS_MATCH_LIMIT,
  cssKey,
  elementForbiddenAsTextOrTagHost,
  elementHasElementChildren,
  elementHasInteractiveDescendant,
  elementHasVoidOrControlDescendant,
  elementIsPageContainer,
  elementOrAncestorInteractive,
  hashKey,
  INTERACTIVE_ROLES,
  isInteractiveElement,
  isLabelableTextControl,
  isNativeInteractiveHost,
  isSafeInsertHtml,
  localTagName,
  mountKeyFor,
  parsePatchSpec,
  roleAllowedOnElement,
  sanitizeInsertHtml,
} from "./patch-rules.js";

export {
  isAllowedAttributeName,
  isSafeAttributeValue,
  isSafeHref,
  isSafeInsertHtml,
  isSafeMountId,
  parsePatchSpec,
} from "./patch-rules.js";

export function validatePatchSpec(input) {
  return parsePatchSpec(input);
}

function docOf(root) {
  return root.nodeType === 9 ? root : root.ownerDocument;
}

function queryOne(root, selector) {
  try {
    return { el: root.querySelector(selector) };
  } catch {
    return { error: "invalid selector" };
  }
}

function miss(index, selector, extra) {
  const suffix = extra ? `: ${extra}` : "";
  return {
    status: "miss",
    error: `ops[${index}] selector did not match: ${selector}${suffix}`,
  };
}

function applied(undo) {
  return { status: "applied", undo };
}

function noop() {
  return { status: "noop" };
}

function resolveForTarget(root, id) {
  const doc = docOf(root);
  if (!id || typeof id !== "string") return null;
  try {
    return doc.getElementById(id) || root.querySelector?.(`#${CSS.escape ? CSS.escape(id) : id}`);
  } catch {
    return null;
  }
}

function idsResolveToNamedElements(root, value) {
  const ids = String(value)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (ids.length === 0) return false;
  for (const id of ids) {
    const el = resolveForTarget(root, id);
    if (!el || !(el.textContent || "").trim()) return false;
  }
  return true;
}

function applySetAttribute(root, op, index) {
  const found = queryOne(root, op.selector);
  if (found.error) return miss(index, op.selector, found.error);
  const el = found.el;
  if (!(el instanceof Element)) return miss(index, op.selector);
  if (elementForbiddenAsTextOrTagHost(el) || elementIsPageContainer(el)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  const attrName = op.name.toLowerCase();
  if (attrName.startsWith("data-lift-")) {
    return { status: "miss", error: `ops[${index}] disallowed attribute` };
  }
  if (attrName === "class" || attrName === "type" || attrName === "for") {
    return { status: "miss", error: `ops[${index}] disallowed attribute` };
  }
  if (attributeWouldHideInteractive(op.name, op.value, el)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  if (attrName === "aria-labelledby" || attrName === "aria-describedby") {
    if (!idsResolveToNamedElements(root, op.value)) {
      return { status: "miss", error: `ops[${index}] target is not allowlisted` };
    }
  }
  if (attrName === "role" && !roleAllowedOnElement(el, op.value)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  if (el.getAttribute(op.name) === op.value) return noop();
  const had = el.hasAttribute(op.name);
  const prev = el.getAttribute(op.name);
  el.setAttribute(op.name, op.value);
  return applied(() => {
    if (!had) el.removeAttribute(op.name);
    else el.setAttribute(op.name, prev ?? "");
  });
}

function applySetText(root, op, index) {
  const found = queryOne(root, op.selector);
  if (found.error) return miss(index, op.selector, found.error);
  const el = found.el;
  if (!(el instanceof Element)) return miss(index, op.selector);
  if (elementForbiddenAsTextOrTagHost(el) || elementIsPageContainer(el)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  if (elementHasElementChildren(el) || elementHasVoidOrControlDescendant(el)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  if (op.text.trim().length < 1) {
    return { status: "miss", error: `ops[${index}] text required` };
  }
  if (isInteractiveElement(el)) {
    if ((el.textContent || "") === op.text) return noop();
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  const prevChildren = [...el.childNodes];
  if (el.textContent === op.text) return noop();
  el.textContent = op.text;
  return applied(() => {
    el.replaceChildren(...prevChildren);
  });
}

function parseComputedRgb(css) {
  if (typeof css !== "string" || css.length === 0) return null;
  const trimmed = css.trim().toLowerCase();
  if (trimmed === "transparent") return { rgb: [0, 0, 0], alpha: 0 };
  const rgba =
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(trimmed);
  if (rgba) {
    return {
      rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  const rgb = cssColorToRgb(trimmed);
  return rgb ? { rgb, alpha: 1 } : null;
}

const TEXT_DESCENDANT_CAP = 500;
const PAINT_STATES = new Set(["hover", "focus", "focus-visible", "active"]);

function backgroundUnknown(el) {
  let node = el;
  while (node && node.nodeType === 1) {
    const style = getComputedStyle(node);
    const img = String(style.backgroundImage || node.style?.backgroundImage || "")
      .trim()
      .toLowerCase();
    if (img && img !== "none") return true;
    const parsed =
      parseComputedRgb(style.backgroundColor) || parseComputedRgb(node.style?.backgroundColor || "");
    if (parsed && parsed.alpha > 0 && parsed.alpha < 0.99) return true;
    const opacityRaw = String(style.opacity || "").trim();
    if (opacityRaw !== "") {
      const opacity = Number(opacityRaw);
      if (Number.isFinite(opacity) && opacity < 1) return true;
    }
    const inlineOpacityRaw = String(node.style?.opacity || "").trim();
    if (inlineOpacityRaw !== "") {
      const inlineOpacity = Number(inlineOpacityRaw);
      if (Number.isFinite(inlineOpacity) && inlineOpacity < 1) return true;
    }
    node = node.parentElement;
  }
  return false;
}

function effectiveBackgroundRgb(el) {
  if (backgroundUnknown(el)) return null;
  let node = el;
  while (node && node.nodeType === 1) {
    const parsed = parseComputedRgb(getComputedStyle(node).backgroundColor);
    if (parsed && parsed.alpha >= 0.99) return parsed.rgb;
    node = node.parentElement;
  }
  return [255, 255, 255];
}

function largeTextThreshold(el) {
  const style = getComputedStyle(el);
  const px = Number.parseFloat(style.fontSize);
  const weight = style.fontWeight;
  const bold = weight === "bold" || Number(weight) >= 700;
  if (Number.isFinite(px) && px >= 24) return 3;
  if (Number.isFinite(px) && px >= 18.66 && bold) return 3;
  return 4.5;
}

function isTextBearing(el) {
  if (!el || !el.childNodes) return false;
  for (const node of el.childNodes) {
    if (node.nodeType === 3 && String(node.textContent || "").trim()) return true;
  }
  return false;
}

function checkNodeContrast(el, minRatio) {
  const fg = parseComputedRgb(getComputedStyle(el).color);
  if (!fg || fg.alpha < 0.99) return null;
  const bg = effectiveBackgroundRgb(el);
  if (!bg) return "background is not allowlisted";
  const min = minRatio ?? largeTextThreshold(el);
  if (contrastRatio(fg.rgb, bg) < min) return "contrast is not allowlisted";
  return null;
}

function colorValueFromRule(rule, property) {
  const decl = (rule.declarations || []).find((d) => d.property === property);
  return decl ? cssColorToRgb(decl.value) : null;
}

function cssMatchesViolateHostsOrContrast(root, op) {
  const scope = "querySelectorAll" in root ? root : docOf(root);
  for (const rule of op.rules || []) {
    let matches;
    try {
      matches = scope.querySelectorAll(serializeSelectorForQuery(rule.selector));
    } catch {
      return "invalid selector";
    }
    if (matches.length === 0) return "selector matched nothing";
    if (matches.length > CSS_MATCH_LIMIT) return "too many matches";
    const decls = rule.declarations || [];
    const changesPaint = decls.some(
      (d) => d.property === "color" || d.property === "background-color",
    );
    const outlineColor = colorValueFromRule(rule, "outline-color");
    const borderColor = colorValueFromRule(rule, "border-color");
    const isState = Boolean(rule.selector && PAINT_STATES.has(rule.selector.state));
    for (const el of matches) {
      if (elementIsPageContainer(el) || elementForbiddenAsTextOrTagHost(el)) {
        return "target is not allowlisted";
      }
      if (changesPaint && backgroundUnknown(el)) return "background is not allowlisted";
      const nodes = [el, ...el.querySelectorAll("*")];
      if (nodes.length > TEXT_DESCENDANT_CAP) return "too many descendants";
      for (const node of nodes) {
        if (node !== el && !isTextBearing(node)) continue;
        const err = checkNodeContrast(node);
        if (err) return err;
      }
      const bg = effectiveBackgroundRgb(el);
      if (outlineColor) {
        if (!bg) return "background is not allowlisted";
        if (contrastRatio(outlineColor, bg) < 3) return "contrast is not allowlisted";
      }
      if (!isState && borderColor) {
        if (!bg) return "background is not allowlisted";
        if (contrastRatio(borderColor, bg) < 3) return "contrast is not allowlisted";
      }
    }
  }
  return null;
}

function applyInjectCss(root, op, index) {
  const doc = docOf(root);
  const id = cssKey(op);
  const existing = doc.getElementById(id);
  let undo;
  if (existing && localTagName(existing) === "style") {
    const prev = existing.textContent ?? "";
    if (prev === op.css) {
      const hostErr = cssMatchesViolateHostsOrContrast(root, op);
      if (hostErr) return { status: "miss", error: `ops[${index}] ${hostErr}` };
      return noop();
    }
    existing.textContent = op.css;
    undo = () => {
      existing.textContent = prev;
    };
  } else {
    const style = doc.createElement("style");
    style.id = id;
    style.setAttribute("data-lift-css", "1");
    style.textContent = op.css;
    const parent = doc.head ?? doc.documentElement;
    parent.appendChild(style);
    undo = () => {
      style.remove();
    };
  }
  const hostErr = cssMatchesViolateHostsOrContrast(root, op);
  if (hostErr) {
    undo();
    return { status: "miss", error: `ops[${index}] ${hostErr}` };
  }
  return applied(undo);
}

function alreadyLabelled(input) {
  if (input.getAttribute("data-labelled") === "1") return true;
  if (input.getAttribute("aria-label")) return true;
  if (input.getAttribute("aria-labelledby")) return true;
  const labels = input.labels;
  return Boolean(labels && labels.length > 0);
}

function applyWrapLabel(root, op, index) {
  const found = queryOne(root, op.selector);
  if (found.error) return miss(index, op.selector, found.error);
  const input = found.el;
  if (!(input instanceof Element)) return miss(index, op.selector);
  const tag = localTagName(input);
  if (tag !== "input" && tag !== "select" && tag !== "textarea") {
    if (elementForbiddenAsTextOrTagHost(input) || elementIsPageContainer(input)) {
      return { status: "miss", error: `ops[${index}] target is not allowlisted` };
    }
  }
  if (!isLabelableTextControl(input)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  if (alreadyLabelled(input)) return noop();
  const id = input.id;
  if (!id) return miss(index, op.selector, "input has no id");
  const doc = docOf(root);
  const label = doc.createElement("label");
  label.setAttribute("for", id);
  label.textContent = op.text;
  const prevSibling = input.previousElementSibling;
  const hint =
    prevSibling && prevSibling.classList.contains("visible-hint") ? prevSibling : null;
  const hadUnlabeled = input.hasAttribute("data-unlabeled");
  const unlabeledValue = hadUnlabeled ? input.getAttribute("data-unlabeled") : null;
  const hadLabelled = input.hasAttribute("data-labelled");
  const labelledValue = hadLabelled ? input.getAttribute("data-labelled") : null;
  input.removeAttribute("data-unlabeled");
  input.setAttribute("data-labelled", "1");
  if (hint) {
    replacementOf.set(hint, label);
    hint.replaceWith(label);
  } else input.insertAdjacentElement("beforebegin", label);
  return applied(() => {
    if (hint) {
      replacementOf.delete(hint);
      label.replaceWith(hint);
    } else label.remove();
    if (!hadLabelled) input.removeAttribute("data-labelled");
    else input.setAttribute("data-labelled", labelledValue ?? "");
    if (hadUnlabeled) input.setAttribute("data-unlabeled", unlabeledValue ?? "");
    else input.removeAttribute("data-unlabeled");
  });
}

function applyMakeFocusable(root, op, index) {
  const found = queryOne(root, op.selector);
  if (found.error) return miss(index, op.selector, found.error);
  const el = found.el;
  if (!(el instanceof HTMLElement)) return miss(index, op.selector);
  if (elementForbiddenAsTextOrTagHost(el) || elementIsPageContainer(el)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  if (el.getAttribute("data-lift-focusable") === "1") return noop();
  const hadTab = el.hasAttribute("tabindex");
  const prevTab = el.getAttribute("tabindex");
  el.tabIndex = 0;
  el.setAttribute("data-lift-focusable", "1");
  return applied(() => {
    el.removeAttribute("data-lift-focusable");
    if (!hadTab) el.removeAttribute("tabindex");
    else el.setAttribute("tabindex", prevTab ?? "0");
  });
}

function applyBindEnterToClick(root, op, index) {
  const found = queryOne(root, op.selector);
  if (found.error) return miss(index, op.selector, found.error);
  const el = found.el;
  if (!(el instanceof HTMLElement)) return miss(index, op.selector);
  if (elementForbiddenAsTextOrTagHost(el) || elementIsPageContainer(el)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  if (elementHasInteractiveDescendant(el)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  if (el.getAttribute("data-lift-enter") === "1") return noop();
  const onKey = (event) => {
    if (event.target !== el) return;
    if (event.key === "Enter") {
      event.preventDefault();
      el.click();
    }
  };
  el.addEventListener("keydown", onKey);
  el.setAttribute("data-lift-enter", "1");
  return applied(() => {
    el.removeEventListener("keydown", onKey);
    el.removeAttribute("data-lift-enter");
  });
}

const FORWARDED_TO = new WeakMap();
const replacementRoot = new WeakMap();
const replacementOf = new WeakMap();

function alreadyForwardedTo(event, target) {
  const set = FORWARDED_TO.get(event);
  return Boolean(set && set.has(target));
}

function markForwardedTo(event, target) {
  let set = FORWARDED_TO.get(event);
  if (!set) {
    set = new Set();
    FORWARDED_TO.set(event, set);
  }
  set.add(target);
}

function isNativeActivator(el) {
  const tag = localTagName(el);
  if (tag === "button") return true;
  if (tag === "a" && el.hasAttribute("href")) return true;
  return false;
}

function forwardUiEvents(from, to) {
  const nativeActivator = isNativeActivator(from);
  const onClick = (event) => {
    if (alreadyForwardedTo(event, to)) return;
    markForwardedTo(event, to);
    let copy;
    try {
      copy = new event.constructor(event.type, event);
    } catch {
      copy = new Event(event.type, { bubbles: event.bubbles, cancelable: event.cancelable });
    }
    markForwardedTo(copy, to);
    const prior = FORWARDED_TO.get(event);
    if (prior) FORWARDED_TO.set(copy, new Set(prior));
    to.dispatchEvent(copy);
  };
  from.addEventListener("click", onClick);
  let onKey = null;
  if (!nativeActivator) {
    onKey = (event) => {
      if (from.getAttribute("data-lift-enter") === "1") return;
      if (alreadyForwardedTo(event, to)) return;
      markForwardedTo(event, to);
      let copy;
      try {
        copy = new event.constructor(event.type, event);
      } catch {
        copy = new Event(event.type, { bubbles: event.bubbles, cancelable: event.cancelable });
      }
      markForwardedTo(copy, to);
      const prior = FORWARDED_TO.get(event);
      if (prior) FORWARDED_TO.set(copy, new Set(prior));
      to.dispatchEvent(copy);
    };
    from.addEventListener("keydown", onKey);
  }
  return () => {
    from.removeEventListener("click", onClick);
    if (onKey) from.removeEventListener("keydown", onKey);
  };
}

function replaceTagKey(op) {
  return hashKey(`${op.selector}|${op.tag}|${JSON.stringify(op.attributes ?? {})}`);
}

function findReplaced(root, key) {
  const scope = "querySelectorAll" in root ? root : docOf(root);
  for (const el of scope.querySelectorAll("[data-lift-replaced]")) {
    if (el.getAttribute("data-lift-replaced") === key) return el;
  }
  return null;
}

function copyAttributesExceptHandlers(from, to) {
  for (const attr of [...from.attributes]) {
    if (attr.name.toLowerCase().startsWith("on")) continue;
    to.setAttribute(attr.name, attr.value);
  }
}

function forTargetAllowed(root, op) {
  const forValue = op.attributes && op.attributes.for;
  if (op.tag !== "label" || !forValue) return true;
  return isLabelableTextControl(resolveForTarget(root, forValue));
}

function ensureButtonType(el) {
  if (localTagName(el) !== "button") return null;
  const had = el.hasAttribute("type");
  const prev = el.getAttribute("type");
  if (prev === "button") return null;
  el.setAttribute("type", "button");
  return () => {
    if (!had) el.removeAttribute("type");
    else el.setAttribute("type", prev ?? "");
  };
}

function overlayAttributes(el, attrs) {
  const undoAttrs = [];
  for (const [name, value] of Object.entries(attrs)) {
    const attrName = name.toLowerCase();
    if (attrName === "class" || attrName === "type") continue;
    if (el.getAttribute(name) === value) continue;
    const had = el.hasAttribute(name);
    const prev = el.getAttribute(name);
    el.setAttribute(name, value);
    undoAttrs.push(() => {
      if (!had) el.removeAttribute(name);
      else el.setAttribute(name, prev ?? "");
    });
  }
  if (undoAttrs.length === 0) return noop();
  return applied(() => {
    for (const undo of undoAttrs.reverse()) undo();
  });
}

function applyReplaceTag(root, op, index) {
  const key = replaceTagKey(op);
  const existing = findReplaced(root, key);
  if (existing) {
    if (!forTargetAllowed(root, op)) {
      return { status: "miss", error: `ops[${index}] target is not allowlisted` };
    }
    const overlay = overlayAttributes(existing, op.attributes || {});
    const undoType = ensureButtonType(existing);
    if (overlay.status === "noop" && !undoType) return overlay;
    return applied(() => {
      if (overlay.status === "applied") overlay.undo();
      if (undoType) undoType();
    });
  }
  const found = queryOne(root, op.selector);
  if (found.error) return miss(index, op.selector, found.error);
  const el = found.el;
  if (!(el instanceof Element)) return miss(index, op.selector);
  if (elementForbiddenAsTextOrTagHost(el) || elementIsPageContainer(el)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  if (isNativeInteractiveHost(el) && op.tag !== "button" && op.tag !== "a") {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  if (elementHasVoidOrControlDescendant(el) || elementHasInteractiveDescendant(el)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  if (el.getAttribute("data-lift-replaced") === key) {
    if (!forTargetAllowed(root, op)) {
      return { status: "miss", error: `ops[${index}] target is not allowlisted` };
    }
    const overlay = overlayAttributes(el, op.attributes || {});
    const undoType = ensureButtonType(el);
    if (overlay.status === "noop" && !undoType) return overlay;
    return applied(() => {
      if (overlay.status === "applied") overlay.undo();
      if (undoType) undoType();
    });
  }
  if (el.tagName.toLowerCase() === op.tag.toLowerCase()) {
    if (!forTargetAllowed(root, op)) {
      return { status: "miss", error: `ops[${index}] target is not allowlisted` };
    }
    const hadMarker = el.hasAttribute("data-lift-replaced");
    const prevMarker = el.getAttribute("data-lift-replaced");
    el.setAttribute("data-lift-replaced", key);
    const overlay = overlayAttributes(el, op.attributes || {});
    const undoType = ensureButtonType(el);
    return applied(() => {
      if (overlay.status === "applied") overlay.undo();
      if (undoType) undoType();
      if (!hadMarker) el.removeAttribute("data-lift-replaced");
      else el.setAttribute("data-lift-replaced", prevMarker ?? "");
    });
  }
  const forValue = op.attributes && op.attributes.for;
  if (op.tag === "label" && forValue) {
    const forTarget = resolveForTarget(root, forValue);
    if (!isLabelableTextControl(forTarget)) {
      return { status: "miss", error: `ops[${index}] target is not allowlisted` };
    }
  }
  const doc = docOf(root);
  const next = doc.createElement(op.tag);
  copyAttributesExceptHandlers(el, next);
  for (const [name, value] of Object.entries(op.attributes || {})) {
    if (name.toLowerCase() === "class" || name.toLowerCase() === "type") continue;
    next.setAttribute(name, value);
  }
  if (op.tag === "button") next.setAttribute("type", "button");
  next.setAttribute("data-lift-replaced", key);
  while (el.firstChild) next.appendChild(el.firstChild);
  const rootOriginal = replacementRoot.get(el) ?? el;
  replacementRoot.set(next, rootOriginal);
  replacementOf.set(el, next);
  el.replaceWith(next);
  const stopForward = forwardUiEvents(next, rootOriginal);
  return applied(() => {
    stopForward();
    replacementRoot.delete(next);
    replacementOf.delete(el);
    while (next.firstChild) el.appendChild(next.firstChild);
    next.replaceWith(el);
  });
}

function findMount(root, mountId) {
  const scope = "querySelectorAll" in root ? root : docOf(root);
  for (const el of scope.querySelectorAll("[data-lift-mount]")) {
    if (el.getAttribute("data-lift-mount") === mountId) return el;
  }
  return null;
}

function applyInsertHtml(root, op, index) {
  const key = mountKeyFor(op);
  if (findMount(root, key)) return noop();
  const found = queryOne(root, op.selector);
  if (found.error) return miss(index, op.selector, found.error);
  const target = found.el;
  if (!(target instanceof Element)) return miss(index, op.selector);
  if (elementForbiddenAsTextOrTagHost(target) || elementIsPageContainer(target)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  if (elementOrAncestorInteractive(target)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  const doc = docOf(root);
  if (!isSafeInsertHtml(op.html, doc)) {
    return { status: "miss", error: `ops[${index}] html is not allowlisted` };
  }
  const fragment = sanitizeInsertHtml(op.html, doc);
  if (!fragment) return { status: "miss", error: `ops[${index}] html is not allowlisted` };
  for (const node of fragment.querySelectorAll("*")) {
    for (const attr of [...node.attributes]) {
      if (attributeWouldHideInteractive(attr.name, attr.value, node)) {
        return { status: "miss", error: `ops[${index}] html is not allowlisted` };
      }
    }
  }
  const holder = doc.createElement("span");
  holder.setAttribute("data-lift-mount", key);
  holder.setAttribute("data-lift-inserted", "1");
  holder.appendChild(fragment);
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
      return { status: "miss", error: `ops[${index}] position must be before|after|prepend|append` };
  }
  return applied(() => {
    holder.remove();
  });
}

function applyToggleDisclosure(root, op, index) {
  const triggerFound = queryOne(root, op.trigger);
  if (triggerFound.error) return miss(index, op.trigger, triggerFound.error);
  const panelFound = queryOne(root, op.panel);
  if (panelFound.error) return miss(index, op.panel, panelFound.error);
  const trigger = triggerFound.el;
  const panel = panelFound.el;
  if (!(trigger instanceof HTMLElement) || !(panel instanceof HTMLElement)) {
    return miss(index, op.trigger);
  }
  if (elementForbiddenAsTextOrTagHost(trigger) || elementForbiddenAsTextOrTagHost(panel)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  if (elementIsPageContainer(trigger) || elementIsPageContainer(panel)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  if (trigger.getAttribute("data-lift-disclosure") === "1") return noop();
  const hadExpanded = trigger.hasAttribute("aria-expanded");
  const prevExpanded = trigger.getAttribute("aria-expanded");
  const hadOpen = panel.classList.contains("lift-open");
  const onClick = (event) => {
    if (!trigger.contains(event.target)) return;
    const open = panel.classList.toggle("lift-open");
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
  };
  trigger.addEventListener("click", onClick);
  trigger.setAttribute("data-lift-disclosure", "1");
  if (!hadExpanded) trigger.setAttribute("aria-expanded", "false");
  return applied(() => {
    trigger.removeEventListener("click", onClick);
    trigger.removeAttribute("data-lift-disclosure");
    if (!hadExpanded) trigger.removeAttribute("aria-expanded");
    else trigger.setAttribute("aria-expanded", prevExpanded ?? "false");
    if (!hadOpen) panel.classList.remove("lift-open");
    else panel.classList.add("lift-open");
  });
}

function applyOp(root, op, index) {
  switch (op.op) {
    case "setAttribute":
      return applySetAttribute(root, op, index);
    case "setText":
      return applySetText(root, op, index);
    case "injectCSS":
      return applyInjectCss(root, op, index);
    case "wrapLabel":
      return applyWrapLabel(root, op, index);
    case "makeFocusable":
      return applyMakeFocusable(root, op, index);
    case "bindEnterToClick":
      return applyBindEnterToClick(root, op, index);
    case "replaceTag":
      return applyReplaceTag(root, op, index);
    case "insertHTML":
      return applyInsertHtml(root, op, index);
    case "toggleDisclosure":
      return applyToggleDisclosure(root, op, index);
    default:
      return { status: "miss", error: `ops[${index}] unknown op: ${String(op.op)}` };
  }
}

function undoAll(undos) {
  for (const undo of undos.reverse()) {
    try {
      undo();
    } catch {
      /* fail-open: best-effort undo */
    }
  }
}

function liveSuccessor(el) {
  let cur = el;
  const seen = new Set();
  while (cur && !cur.isConnected) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    cur = replacementOf.get(cur);
  }
  return cur && cur.isConnected ? cur : null;
}

function isFocusableSnap(el) {
  if (!(el instanceof HTMLElement)) return false;
  if ("disabled" in el && el.disabled) return false;
  if ((el.getAttribute("aria-disabled") || "").trim().toLowerCase() === "true") return false;
  return el.tabIndex >= 0;
}

function isRenderedVisible(el) {
  if (!(el instanceof Element)) return false;
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  const opacity = Number(style.opacity);
  if (Number.isFinite(opacity) && opacity <= 0) return false;
  const rects = typeof el.getClientRects === "function" ? el.getClientRects() : [];
  if (!rects || rects.length === 0) return false;
  const box = el.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

function computedRole(el) {
  const explicit = String(el.getAttribute("role") || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)[0];
  if (explicit) return explicit;
  const tag = localTagName(el);
  if (tag === "button") return "button";
  if (tag === "a" && el.hasAttribute("href")) return "link";
  if (tag === "summary") return "button";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "input") {
    const type = (el.getAttribute("type") || "text").trim().toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "submit" || type === "reset" || type === "button" || type === "image") return "button";
    return "textbox";
  }
  return tag;
}

function accessibleName(el) {
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const doc = el.ownerDocument;
    const parts = by
      .trim()
      .split(/\s+/)
      .map((id) => (doc.getElementById(id)?.textContent || "").trim())
      .filter(Boolean);
    if (parts.length) return parts.join(" ");
  }
  const aria = (el.getAttribute("aria-label") || "").trim();
  if (aria) return aria;
  const labels = el.labels;
  if (labels && labels.length) {
    const t = [...labels]
      .map((lab) => (lab.textContent || "").trim())
      .filter(Boolean)
      .join(" ");
    if (t) return t;
  }
  const wrap = typeof el.closest === "function" ? el.closest("label") : null;
  if (wrap && wrap !== el) {
    const t = (wrap.textContent || "").trim();
    if (t) return t;
  }
  if (el.id) {
    try {
      const lab = el.ownerDocument.querySelector(`label[for="${CSS.escape ? CSS.escape(el.id) : el.id}"]`);
      const t = (lab?.textContent || "").trim();
      if (t) return t;
    } catch {
      /* ignore */
    }
  }
  const text = (el.textContent || "").trim();
  if (text) return text;
  const alt = (el.getAttribute("alt") || "").trim();
  if (alt) return alt;
  return (el.getAttribute("title") || "").trim();
}

function isAriaHiddenChain(el) {
  let node = el;
  while (node && node.nodeType === 1) {
    if ((node.getAttribute("aria-hidden") || "").trim().toLowerCase() === "true") return true;
    node = node.parentElement;
  }
  return false;
}

function snapshotA11y(el) {
  const tag = localTagName(el);
  return {
    el,
    focusable: isFocusableSnap(el),
    visible: isRenderedVisible(el),
    role: computedRole(el),
    name: accessibleName(el),
    ariaHidden: isAriaHiddenChain(el),
    ariaDisabled: (el.getAttribute("aria-disabled") || "").trim().toLowerCase() === "true",
    buttonType: tag === "button" ? (el.getAttribute("type") || "submit").toLowerCase() : null,
  };
}

function opMatchSelectors(op) {
  if (op.op === "injectCSS") {
    return (op.rules || []).map((rule) => serializeSelectorForQuery(rule.selector));
  }
  if (op.op === "toggleDisclosure") return [op.trigger, op.panel];
  return op.selector ? [op.selector] : [];
}

function collectWatchElements(root, spec) {
  const scope = "querySelectorAll" in root ? root : docOf(root);
  const watched = new Set();
  const addInteractiveTree = (host) => {
    if (!host || host.nodeType !== 1) return;
    if (isInteractiveElement(host) || accessibleName(host)) watched.add(host);
    if (typeof host.querySelectorAll !== "function") return;
    for (const child of host.querySelectorAll("*")) {
      if (isInteractiveElement(child) || accessibleName(child)) watched.add(child);
    }
  };
  for (const op of spec.ops) {
    for (const selector of opMatchSelectors(op)) {
      let matches;
      try {
        matches = scope.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const el of matches) {
        addInteractiveTree(el);
        let anc = el.parentElement;
        while (anc) {
          addInteractiveTree(anc);
          anc = anc.parentElement;
        }
      }
    }
  }
  return [...watched];
}

function monotonicityViolation(root, snapshots) {
  for (const before of snapshots) {
    const live = liveSuccessor(before.el) || (before.el.isConnected ? before.el : null);
    if (!live) return "lost interactive element";
    const after = snapshotA11y(live);
    if (before.focusable && !after.focusable) return "lost focusability";
    if (before.visible && !after.visible) return "lost visibility";
    if (INTERACTIVE_ROLES.has(before.role) && after.role !== before.role) {
      return "changed interactive role";
    }
    if (before.name && !after.name) return "lost name";
    if (!before.ariaHidden && after.ariaHidden) return "became aria-hidden";
    if (!before.ariaDisabled && after.ariaDisabled) return "became aria-disabled";
    if (
      before.buttonType &&
      after.buttonType &&
      after.buttonType !== before.buttonType &&
      (after.buttonType === "submit" || after.buttonType === "reset")
    ) {
      return "button type changed to submit or reset";
    }
  }
  return null;
}

function specContrastError(root, spec) {
  for (const op of spec.ops) {
    if (op.op !== "injectCSS") continue;
    const err = cssMatchesViolateHostsOrContrast(root, op);
    if (err) return err;
  }
  return null;
}

const activeGuards = [];

export function resetRuntimeGuards() {
  const stops = activeGuards.splice(0);
  for (const stop of stops) {
    try {
      stop();
    } catch {
      /* test isolation */
    }
  }
  if (typeof window !== "undefined") window.__LIFT_FAIL_OPEN__ = [];
}

function recordFailOpen(reason, specId) {
  const detail = { reason, specId, at: Date.now() };
  if (typeof window === "undefined") return;
  window.__LIFT_FAIL_OPEN__ = window.__LIFT_FAIL_OPEN__ || [];
  window.__LIFT_FAIL_OPEN__.push(detail);
  window.dispatchEvent(new CustomEvent("lift:fail-open", { detail }));
}

function installMutationGuard(root, spec, snapshots, undos) {
  const doc = docOf(root);
  if (!doc || typeof MutationObserver !== "function") return () => {};
  let timer = null;
  let stopped = false;
  const observer = new MutationObserver(() => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      observer.disconnect();
      const err = specContrastError(root, spec) || monotonicityViolation(root, snapshots);
      if (err) {
        stopped = true;
        undoAll(undos);
        recordFailOpen(err, spec.id);
        return;
      }
      const node = doc.documentElement || root;
      try {
        observer.observe(node, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["class"],
        });
      } catch {
        /* closed document */
      }
    }, 32);
  });
  const node = doc.documentElement || root;
  try {
    observer.observe(node, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
  } catch {
    return () => {};
  }
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    observer.disconnect();
  };
}

/** Apply a validated spec. On throw or a required-selector miss, undo so the page is untouched. */
export function applyPatchSpec(input, root) {
  const opsStatus = [];
  try {
    const parsed = parsePatchSpec(input);
    if (!parsed.ok) return { ok: false, error: parsed.error, ops: opsStatus };
    const scope = root ?? (typeof document === "undefined" ? null : document);
    if (!scope) return { ok: false, error: "no document", ops: opsStatus };
    const snapshots = collectWatchElements(scope, parsed.spec).map(snapshotA11y);
    const undos = [];
    try {
      for (let i = 0; i < parsed.spec.ops.length; i++) {
        const op = parsed.spec.ops[i];
        const result = applyOp(scope, op, i);
        if (result.status === "miss") {
          undoAll(undos);
          return { ok: false, error: result.error, ops: opsStatus };
        }
        if (result.status === "applied") {
          undos.push(result.undo);
          opsStatus.push({ op: op.op, status: "applied" });
        } else {
          opsStatus.push({ op: op.op, status: "noop" });
        }
      }
      const contrastErr = specContrastError(scope, parsed.spec);
      if (contrastErr) {
        undoAll(undos);
        return { ok: false, error: contrastErr, ops: opsStatus };
      }
      const monoErr = monotonicityViolation(scope, snapshots);
      if (monoErr) {
        undoAll(undos);
        return { ok: false, error: monoErr, ops: opsStatus };
      }
      const stopGuard = installMutationGuard(scope, parsed.spec, snapshots, [...undos]);
      activeGuards.push(stopGuard);
      undos.push(stopGuard);
      return { ok: true, ops: opsStatus };
    } catch (err) {
      undoAll(undos);
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ops: opsStatus,
      };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ops: opsStatus,
    };
  }
}

if (typeof window !== "undefined") {
  window.LiftRuntime = { applyPatchSpec, validatePatchSpec, resetRuntimeGuards };
}
