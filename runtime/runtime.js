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
  GUARD_MAX_WAIT_MS,
  hashKey,
  INTERACTIVE_ROLES,
  isFormControl,
  isInteractiveElement,
  isLabelableTextControl,
  isSafeInsertHtml,
  LANDMARK_ROLES,
  localTagName,
  mountKeyFor,
  parsePatchSpec,
  hasBlockPromoteChild,
  promoteHostAllowed,
  roleAllowedOnElement,
  sanitizeInsertHtml,
  STRUCTURAL_ROLES,
  WATCH_NODE_CAP,
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
    if (!isRenderedVisible(el) || isAriaHiddenChain(el)) return false;
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
  if (
    (attrName === "aria-label" || attrName === "aria-labelledby") &&
    !labelInNameHolds(el, proposedAccessibleName(root, el, attrName, op.value))
  ) {
    return { status: "miss", error: `ops[${index}] name does not contain visible text` };
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

let backstopsPaused = false;
const pendingBackstops = [];
const guardFlushers = [];
const TEXT_DESCENDANT_CAP = 500;
const SIZE_GROWING_PROPS = new Set([
  "font-size",
  "padding",
  "line-height",
  "margin",
  "letter-spacing",
  "word-spacing",
  "min-height",
  "min-width",
  "border-width",
]);

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

function hostOrAncestorIsOutOfFlow(el) {
  let node = el;
  while (node && node.nodeType === 1) {
    const pos = String(getComputedStyle(node).position || "").toLowerCase();
    if (pos === "fixed" || pos === "sticky" || pos === "absolute") return true;
    node = node.parentElement;
  }
  return false;
}

function decorationIncludesLineThrough(el) {
  let node = el;
  while (node && node.nodeType === 1) {
    const tag = localTagName(node);
    if (tag === "del" || tag === "s" || tag === "strike") return true;
    const deco = `${getComputedStyle(node).textDecorationLine || ""} ${
      getComputedStyle(node).textDecoration || ""
    }`;
    if (/\bline-through\b/i.test(deco)) return true;
    node = node.parentElement;
  }
  return false;
}

function pxFromDeclOrStyle(decls, property, styleValue) {
  const decl = (decls || []).find((d) => d.property === property);
  if (decl) {
    const n = Number.parseFloat(decl.value);
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number.parseFloat(styleValue || "0");
  return Number.isFinite(n) ? n : 0;
}

function outlineBudgetExceeded(decls, el) {
  const style = el ? getComputedStyle(el) : null;
  const width = pxFromDeclOrStyle(decls, "outline-width", style?.outlineWidth);
  const offset = pxFromDeclOrStyle(decls, "outline-offset", style?.outlineOffset);
  return width + offset > 4;
}

function hostHasFixedHeightAndHiddenOverflow(el) {
  const style = getComputedStyle(el);
  const overflow = String(style.overflow || "").toLowerCase();
  const clips = overflow === "hidden" || overflow === "clip";
  if (!clips) return false;
  const height = String(style.height || "");
  if (!height || height === "auto" || height === "0px") return false;
  const px = Number.parseFloat(height);
  return Number.isFinite(px) && px > 0;
}

function cssMatchesViolateHostsOrContrast(root, op, mode) {
  const scope = "querySelectorAll" in root ? root : docOf(root);
  const guard = mode === "guard";
  for (const rule of op.rules || []) {
    let matches;
    try {
      matches = scope.querySelectorAll(serializeSelectorForQuery(rule.selector));
    } catch {
      return "invalid selector";
    }
    if (matches.length === 0) {
      if (guard) continue;
      return "selector matched nothing";
    }
    if (matches.length > CSS_MATCH_LIMIT) return "too many matches";
    const decls = rule.declarations || [];
    const changesPaint = decls.some(
      (d) => d.property === "color" || d.property === "background-color",
    );
    const grows = decls.some((d) => SIZE_GROWING_PROPS.has(d.property));
    const setsUnderline = decls.some(
      (d) => d.property === "text-decoration-line" && String(d.value) === "underline",
    );
    const outlineColor = colorValueFromRule(rule, "outline-color");
    const borderColor = colorValueFromRule(rule, "border-color");
    const isState = Boolean(rule.selector && rule.selector.state);
    for (const el of matches) {
      if (elementIsPageContainer(el) || elementForbiddenAsTextOrTagHost(el)) {
        return "target is not allowlisted";
      }
      if (grows && (hostOrAncestorIsOutOfFlow(el) || hostHasFixedHeightAndHiddenOverflow(el))) {
        return "size change is not allowlisted";
      }
      if (setsUnderline && decorationIncludesLineThrough(el)) {
        return "text-decoration is not allowlisted";
      }
      if (outlineBudgetExceeded(decls, el)) return "outline is not allowlisted";
      if (changesPaint && backgroundUnknown(el)) return "background is not allowlisted";
      const nodes = [el, ...el.querySelectorAll("*")];
      if (nodes.length > TEXT_DESCENDANT_CAP) return "too many descendants";
      for (const node of nodes) {
        if (node !== el && !isTextBearing(node) && !isFormControl(node)) continue;
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
      if (!backstopsPaused) {
        const hostErr = cssMatchesViolateHostsOrContrast(root, op, "apply");
        if (hostErr) return { status: "miss", error: `ops[${index}] ${hostErr}` };
      }
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
  if (!backstopsPaused) {
    const hostErr = cssMatchesViolateHostsOrContrast(root, op, "apply");
    if (hostErr) {
      undo();
      return { status: "miss", error: `ops[${index}] ${hostErr}` };
    }
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

function hostHasClickAffordance(el, op) {
  if (op && op.hasClickAffordance === true) return true;
  if (el.hasAttribute && el.hasAttribute("onclick")) return true;
  const cursor = String(getComputedStyle(el).cursor || "").toLowerCase();
  return cursor === "pointer";
}

function applyPromoteToControl(root, op, index) {
  const found = queryOne(root, op.selector);
  if (found.error) return miss(index, op.selector, found.error);
  const el = found.el;
  if (!(el instanceof HTMLElement)) return miss(index, op.selector);
  if (elementForbiddenAsTextOrTagHost(el) || elementIsPageContainer(el)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  if (!promoteHostAllowed(el)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  if (el.parentElement && elementOrAncestorInteractive(el.parentElement)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  if (elementHasInteractiveDescendant(el) || elementHasVoidOrControlDescendant(el)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  if (hasBlockPromoteChild(el)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  if (!hostHasClickAffordance(el, op)) {
    return { status: "miss", error: `ops[${index}] click affordance required` };
  }
  const role = op.as === "link" ? "link" : "button";
  if (el.getAttribute("data-lift-promoted") === role) return noop();
  const hadRole = el.hasAttribute("role");
  const prevRole = el.getAttribute("role");
  const hadTab = el.hasAttribute("tabindex");
  const prevTab = el.getAttribute("tabindex");
  const hadMark = el.hasAttribute("data-lift-promoted");
  const prevMark = el.getAttribute("data-lift-promoted");
  el.setAttribute("role", role);
  if (!hadTab) el.tabIndex = 0;
  el.setAttribute("data-lift-promoted", role);
  const onKey = (event) => {
    if (event.target !== el) return;
    const isEnter = event.key === "Enter";
    const isSpace = event.key === " " || event.key === "Spacebar";
    if (!isEnter && !(role === "button" && isSpace)) return;
    event.preventDefault();
    event.stopPropagation();
    el.click();
  };
  el.addEventListener("keydown", onKey);
  const contrastErr = checkNodeContrast(el);
  if (contrastErr) {
    el.removeEventListener("keydown", onKey);
    if (!hadMark) el.removeAttribute("data-lift-promoted");
    else el.setAttribute("data-lift-promoted", prevMark ?? "");
    if (!hadTab) el.removeAttribute("tabindex");
    else el.setAttribute("tabindex", prevTab ?? "0");
    if (!hadRole) el.removeAttribute("role");
    else el.setAttribute("role", prevRole ?? "");
    return { status: "miss", error: `ops[${index}] ${contrastErr}` };
  }
  return applied(() => {
    el.removeEventListener("keydown", onKey);
    if (!hadMark) el.removeAttribute("data-lift-promoted");
    else el.setAttribute("data-lift-promoted", prevMark ?? "");
    if (!hadTab) el.removeAttribute("tabindex");
    else el.setAttribute("tabindex", prevTab ?? "0");
    if (!hadRole) el.removeAttribute("role");
    else el.setAttribute("role", prevRole ?? "");
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
    case "promoteToControl":
      return applyPromoteToControl(root, op, index);
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

function documentHasLayout(doc) {
  const body = doc && doc.body;
  if (!body || typeof body.getBoundingClientRect !== "function") return false;
  for (const child of body.children) {
    if (typeof child.getBoundingClientRect !== "function") continue;
    const box = child.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) return true;
  }
  return false;
}

function isRenderedVisible(el) {
  if (!(el instanceof Element)) return false;
  if ("hidden" in el && el.hidden) return false;
  if (el.hasAttribute && el.hasAttribute("hidden")) return false;
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  const opacityRaw = String(style.opacity || "").trim();
  if (opacityRaw !== "") {
    const opacity = Number(opacityRaw);
    if (Number.isFinite(opacity) && opacity <= 0) return false;
  }
  if (!documentHasLayout(el.ownerDocument)) return true;
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

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function visibleText(el) {
  if (!el) return "";
  const clone = el.cloneNode(true);
  if (clone.querySelectorAll) {
    for (const hidden of clone.querySelectorAll("[aria-hidden='true']")) hidden.remove();
  }
  return normalizeName(clone.textContent);
}

function nameContainsVisible(name, visible) {
  const vis = normalizeName(visible);
  if (!vis) return true;
  return normalizeName(name).includes(vis);
}

function labelInNameHolds(el, name) {
  return nameContainsVisible(name, visibleText(el));
}

function proposedAccessibleName(root, el, attrName, value) {
  if (attrName === "aria-label") return value;
  if (attrName === "aria-labelledby") {
    const ids = String(value)
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return ids
      .map((id) => (resolveForTarget(root, id)?.textContent || "").trim())
      .filter(Boolean)
      .join(" ");
  }
  return accessibleName(el);
}

function formOwnerOf(el) {
  if (!el) return null;
  if ("form" in el && el.form) return el.form;
  return typeof el.closest === "function" ? el.closest("form") : null;
}

function hitTargetAtCenter(el) {
  const doc = el.ownerDocument;
  const view = doc && doc.defaultView;
  if (!view || typeof view.document.elementFromPoint !== "function") return null;
  const box = el.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const vw = view.innerWidth || 0;
  const vh = view.innerHeight || 0;
  if (x < 0 || y < 0 || x > vw || y > vh) return null;
  try {
    return view.document.elementFromPoint(x, y);
  } catch {
    return null;
  }
}

function hitIsSelfOrDescendant(el, hit) {
  if (!hit || !el) return false;
  return hit === el || (typeof el.contains === "function" && el.contains(hit));
}

function inViewport(el) {
  const box = el.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return false;
  const view = el.ownerDocument && el.ownerDocument.defaultView;
  const vw = view ? view.innerWidth : 0;
  const vh = view ? view.innerHeight : 0;
  if (!vw && !vh) return box.top >= 0 && box.left >= 0;
  return box.bottom > 0 && box.right > 0 && box.top < vh && box.left < vw;
}

function isOverflowClipped(el) {
  const box = el.getBoundingClientRect();
  let node = el.parentElement;
  while (node && node.nodeType === 1) {
    const style = getComputedStyle(node);
    const overflow = String(style.overflow || "").toLowerCase();
    if (overflow === "hidden" || overflow === "clip" || overflow === "auto" || overflow === "scroll") {
      const parent = node.getBoundingClientRect();
      if (
        box.top < parent.top - 1 ||
        box.left < parent.left - 1 ||
        box.bottom > parent.bottom + 1 ||
        box.right > parent.right + 1
      ) {
        return true;
      }
    }
    node = node.parentElement;
  }
  return false;
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
  const focusable = isFocusableSnap(el);
  const hit = focusable && inViewport(el) ? hitTargetAtCenter(el) : null;
  return {
    el,
    focusable,
    visible: isRenderedVisible(el),
    role: computedRole(el),
    name: accessibleName(el),
    visibleText: visibleText(el),
    ariaHidden: isAriaHiddenChain(el),
    ariaDisabled: (el.getAttribute("aria-disabled") || "").trim().toLowerCase() === "true",
    buttonType: tag === "button" ? (el.getAttribute("type") || "submit").toLowerCase() : null,
    formOwner: formOwnerOf(el),
    hitOk: Boolean(hit && hitIsSelfOrDescendant(el, hit)),
    clipped: isOverflowClipped(el),
  };
}

function isPositionedOverlay(el) {
  const pos = String(getComputedStyle(el).position || "").toLowerCase();
  return pos === "fixed" || pos === "sticky" || pos === "absolute";
}

function collectOverlayElements(root, spec) {
  const scope = "querySelectorAll" in root ? root : docOf(root);
  const overlays = [];
  const seen = new Set();
  const add = (el) => {
    if (!el || seen.has(el)) return;
    seen.add(el);
    overlays.push(el);
  };
  for (const op of spec.ops || []) {
    if (op.op !== "injectCSS") continue;
    for (const rule of op.rules || []) {
      let matches;
      try {
        matches = scope.querySelectorAll(serializeSelectorForQuery(rule.selector));
      } catch {
        continue;
      }
      for (const host of matches) {
        if (isPositionedOverlay(host)) add(host);
        if (typeof host.querySelectorAll !== "function") continue;
        for (const child of host.querySelectorAll("*")) {
          if (isPositionedOverlay(child)) add(child);
        }
      }
    }
  }
  return overlays;
}

function rectIntersection(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  return { left, top, right, bottom, width, height };
}

function elementsFromPointAt(doc, x, y) {
  if (!doc || typeof doc.elementsFromPoint !== "function") return [];
  const view = doc.defaultView;
  const vw = view ? view.innerWidth || 0 : 0;
  const vh = view ? view.innerHeight || 0 : 0;
  try {
    if (vw > 0 && vh > 0 && x >= 0 && y >= 0 && x <= vw && y <= vh) {
      return [...doc.elementsFromPoint(x, y)];
    }
    if (!view || typeof view.scrollTo !== "function") return [];
    const prevX = view.scrollX || 0;
    const prevY = view.scrollY || 0;
    view.scrollTo(prevX + x - vw / 2, prevY + y - vh / 2);
    const adjX = x - ((view.scrollX || 0) - prevX);
    const adjY = y - ((view.scrollY || 0) - prevY);
    const hits = [...doc.elementsFromPoint(adjX, adjY)];
    view.scrollTo(prevX, prevY);
    return hits;
  } catch {
    return [];
  }
}

function overlayPaintsAbove(overlay, control, inter) {
  const doc = control.ownerDocument;
  const hits = elementsFromPointAt(
    doc,
    inter.left + inter.width / 2,
    inter.top + inter.height / 2,
  );
  if (hits.length === 0) {
    const oz = Number.parseFloat(getComputedStyle(overlay).zIndex);
    const cz = Number.parseFloat(getComputedStyle(control).zIndex);
    if (Number.isFinite(oz) && Number.isFinite(cz)) return oz > cz;
    return false;
  }
  for (const hit of hits) {
    if (hit === overlay || (overlay.contains && overlay.contains(hit))) return true;
    if (hit === control || (control.contains && control.contains(hit))) return false;
  }
  return false;
}

function coverageHitsFor(control, overlays) {
  const crect = control.getBoundingClientRect();
  const area = crect.width * crect.height;
  if (area <= 0) return [];
  const hits = [];
  for (const overlay of overlays) {
    if (overlay === control) continue;
    if (control.contains && control.contains(overlay)) continue;
    if (overlay.contains && overlay.contains(control)) continue;
    const inter = rectIntersection(crect, overlay.getBoundingClientRect());
    if (!inter) continue;
    if (inter.width * inter.height / area < 0.25) continue;
    if (!overlayPaintsAbove(overlay, control, inter)) continue;
    hits.push(overlay);
  }
  return hits;
}

function overlayCoverageViolation(root, spec, snapshots, extraFocusables) {
  const overlays = collectOverlayElements(root, spec);
  if (overlays.length === 0) return null;
  const items = [];
  const seen = new Set();
  for (const snap of snapshots) {
    const live = liveSuccessor(snap.el) || (snap.el.isConnected ? snap.el : null);
    if (!live || !snap.focusable) continue;
    seen.add(live);
    items.push({ el: live, before: snap.overlayHits || [] });
  }
  for (const el of extraFocusables || []) {
    if (!el || seen.has(el) || !isFocusableSnap(el)) continue;
    seen.add(el);
    items.push({ el, before: [] });
  }
  for (const el of collectFocusables(root)) {
    if (!el || seen.has(el) || !isFocusableSnap(el)) continue;
    seen.add(el);
    items.push({ el, before: [] });
  }
  for (const item of items) {
    const after = coverageHitsFor(item.el, overlays);
    const beforeSet = new Set(item.before);
    for (const overlay of after) {
      if (!beforeSet.has(overlay)) return "covered control";
    }
  }
  return null;
}

function addedFocusablesFromRecords(records) {
  const out = [];
  if (!records) return out;
  for (const rec of records) {
    for (const node of rec.addedNodes || []) {
      if (!node || node.nodeType !== 1) continue;
      if (isFocusableSnap(node)) out.push(node);
      if (typeof node.querySelectorAll !== "function") continue;
      for (const child of node.querySelectorAll(
        'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])',
      )) {
        if (isFocusableSnap(child)) out.push(child);
      }
    }
  }
  return out;
}

function opMatchSelectors(op) {
  if (op.op === "injectCSS") {
    return (op.rules || []).map((rule) => serializeSelectorForQuery(rule.selector));
  }
  if (op.op === "toggleDisclosure") return [op.trigger, op.panel];
  return op.selector ? [op.selector] : [];
}

function shouldWatch(el) {
  if (!el || el.nodeType !== 1) return false;
  return isInteractiveElement(el) || isFocusableSnap(el);
}

function addWatched(set, el) {
  if (shouldWatch(el)) set.add(el);
}

function collectFocusables(root) {
  const doc = docOf(root);
  const scope = "querySelectorAll" in root ? root : doc;
  const out = [];
  let nodes;
  try {
    nodes = scope.querySelectorAll(
      'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])',
    );
  } catch {
    return out;
  }
  for (const el of nodes) {
    out.push(el);
    if (out.length >= WATCH_NODE_CAP) break;
  }
  return out;
}

function collectWatchElements(root, spec) {
  const scope = "querySelectorAll" in root ? root : docOf(root);
  const watched = new Set();
  const matches = [];
  for (const op of spec.ops) {
    for (const selector of opMatchSelectors(op)) {
      let found;
      try {
        found = scope.querySelectorAll(selector);
      } catch {
        continue;
      }
      if (found.length > WATCH_NODE_CAP) {
        return { error: "too many watched nodes" };
      }
      for (const el of found) {
        matches.push(el);
        watched.add(el);
        if (watched.size > WATCH_NODE_CAP) return { error: "too many watched nodes" };
        if (typeof el.querySelectorAll === "function") {
          for (const child of el.querySelectorAll("*")) {
            addWatched(watched, child);
            if (watched.size > WATCH_NODE_CAP) {
              return { error: "too many watched nodes" };
            }
          }
        }
        let anc = el.parentElement;
        while (anc) {
          for (const child of anc.children || []) {
            if (isInteractiveElement(child) || isFocusableSnap(child)) watched.add(child);
          }
          if (watched.size > WATCH_NODE_CAP) {
            return { error: "too many watched nodes" };
          }
          anc = anc.parentElement;
        }
      }
    }
  }
  for (const el of collectFocusables(scope)) addWatched(watched, el);
  if (watched.size > WATCH_NODE_CAP) return { error: "too many watched nodes" };
  return { elements: [...watched], matches };
}

function roleMustBeStable(role) {
  if (!role) return false;
  if (INTERACTIVE_ROLES.has(role) || LANDMARK_ROLES.has(role) || STRUCTURAL_ROLES.has(role)) {
    return true;
  }
  if (/^h[1-6]$/.test(role)) return true;
  if (role === "li" || role === "ul" || role === "ol" || role === "dl" || role === "dt" || role === "dd") {
    return true;
  }
  if (role === "label" || role === "table" || role === "tr" || role === "td" || role === "th") return true;
  return false;
}

function monotonicityViolation(root, snapshots) {
  for (const before of snapshots) {
    const live = liveSuccessor(before.el) || (before.el.isConnected ? before.el : null);
    if (!live) {
      if (before.focusable || (before.role && INTERACTIVE_ROLES.has(before.role))) {
        return "lost interactive element";
      }
      continue;
    }
    const after = snapshotA11y(live);
    if (before.focusable && !after.focusable) return "lost focusability";
    if (before.visible && !after.visible) return "lost visibility";
    if (before.role && after.role !== before.role && roleMustBeStable(before.role)) {
      return "changed role";
    }
    if (before.name && !after.name) return "lost name";
    if (
      (before.focusable || after.focusable || isInteractiveElement(live)) &&
      after.visibleText &&
      !nameContainsVisible(after.name, after.visibleText)
    ) {
      return "lost visible name";
    }
    if (!before.ariaHidden && after.ariaHidden) return "became aria-hidden";
    if (!before.ariaDisabled && after.ariaDisabled) return "became aria-disabled";
    if (before.buttonType && after.buttonType !== before.buttonType) {
      return "button type changed";
    }
    if (before.formOwner && after.formOwner !== before.formOwner) return "lost form owner";
    if (before.hitOk && inViewport(live)) {
      const hit = hitTargetAtCenter(live);
      if (!hitIsSelfOrDescendant(live, hit)) return "lost hit target";
    }
    if (!before.clipped && after.clipped) return "clipped by overflow";
  }
  return null;
}

function attachOverlayHits(root, spec, snapshots) {
  const overlays = collectOverlayElements(root, spec);
  if (overlays.length === 0) return snapshots;
  for (const snap of snapshots) {
    if (!snap.focusable) continue;
    snap.overlayHits = coverageHitsFor(snap.el, overlays);
  }
  return snapshots;
}

function specContrastError(root, spec, mode) {
  for (const op of spec.ops) {
    if (op.op !== "injectCSS") continue;
    const err = cssMatchesViolateHostsOrContrast(root, op, mode);
    if (err) return err;
  }
  return null;
}

const activeGuards = [];
const guardsBySpecId = new Map();
const guardKickers = [];
let cssomWatchCount = 0;
let cssomCleanup = null;

function removeGuard(stop) {
  const i = activeGuards.indexOf(stop);
  if (i >= 0) activeGuards.splice(i, 1);
  for (const [id, entry] of guardsBySpecId) {
    if (entry === stop || (entry && entry.stop === stop)) guardsBySpecId.delete(id);
  }
}

function stopGuardForSpec(id) {
  const entry = guardsBySpecId.get(id);
  if (!entry) return [];
  const undos = entry.undos || [];
  try {
    entry.stop();
  } catch {
    /* already stopped */
  }
  return undos;
}

function kickAllGuards() {
  for (const kick of [...guardKickers]) kick();
}

function ensureCssomWatch() {
  cssomWatchCount += 1;
  if (cssomWatchCount > 1 || cssomCleanup) return;
  const view = typeof window !== "undefined" ? window : null;
  const doc = typeof document !== "undefined" ? document : null;
  if (!view || !doc) return;
  const onResize = () => kickAllGuards();
  const onVis = () => kickAllGuards();
  const onLoad = () => kickAllGuards();
  view.addEventListener("resize", onResize);
  doc.addEventListener("visibilitychange", onVis);
  doc.addEventListener("load", onLoad, true);
  doc.addEventListener("error", onLoad, true);
  const interval = view.setInterval(kickAllGuards, 1500);
  let unpatchSheet = () => {};
  try {
    const proto = CSSStyleSheet.prototype;
    const orig = proto.insertRule;
    if (typeof orig === "function" && !proto.insertRule.__liftPatched) {
      const wrapped = function insertRuleLifted(...args) {
        const result = orig.apply(this, args);
        kickAllGuards();
        return result;
      };
      wrapped.__liftPatched = true;
      proto.insertRule = wrapped;
      unpatchSheet = () => {
        if (proto.insertRule === wrapped) proto.insertRule = orig;
      };
    }
  } catch {
    unpatchSheet = () => {};
  }
  cssomCleanup = () => {
    view.removeEventListener("resize", onResize);
    doc.removeEventListener("visibilitychange", onVis);
    doc.removeEventListener("load", onLoad, true);
    doc.removeEventListener("error", onLoad, true);
    view.clearInterval(interval);
    unpatchSheet();
    cssomCleanup = null;
  };
}

function releaseCssomWatch() {
  cssomWatchCount = Math.max(0, cssomWatchCount - 1);
  if (cssomWatchCount === 0 && cssomCleanup) cssomCleanup();
}

export function resetRuntimeGuards() {
  const stops = activeGuards.splice(0);
  guardsBySpecId.clear();
  pendingBackstops.length = 0;
  guardFlushers.length = 0;
  guardKickers.length = 0;
  backstopsPaused = false;
  cssomWatchCount = 0;
  if (cssomCleanup) cssomCleanup();
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

function testHooksAllowed() {
  if (typeof location === "undefined") return false;
  try {
    const host = String(location.hostname || "").toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return false;
    return new URLSearchParams(location.search).get("lift_bot") === "1";
  } catch {
    return false;
  }
}

function recordsTouchSnapshots(records, snapshots) {
  if (!records || records.length === 0) return snapshots;
  const snapByEl = new Set();
  for (const snap of snapshots) snapByEl.add(snap.el);
  const related = new Set();
  for (const rec of records) {
    const nodes = [];
    if (rec.target && rec.target.nodeType === 1) nodes.push(rec.target);
    for (const node of rec.addedNodes || []) {
      if (node && node.nodeType === 1) nodes.push(node);
    }
    for (const node of nodes) {
      let cur = node;
      while (cur && cur.nodeType === 1) {
        if (snapByEl.has(cur)) related.add(cur);
        cur = cur.parentElement;
      }
    }
  }
  if (related.size === 0) return snapshots;
  return snapshots.filter((snap) => {
    const live = liveSuccessor(snap.el) || (snap.el.isConnected ? snap.el : null);
    if (!live) return true;
    return related.has(live) || related.has(snap.el);
  });
}

function runGuardCheck(root, spec, snapshots, records) {
  const contrastErr = specContrastError(root, spec, "guard");
  if (contrastErr) return contrastErr;
  const extra = addedFocusablesFromRecords(records);
  const coverErr = overlayCoverageViolation(root, spec, snapshots, extra);
  if (coverErr) return coverErr;
  const subset = recordsTouchSnapshots(records, snapshots);
  return monotonicityViolation(root, subset);
}

function observeOptions() {
  return { childList: true, subtree: true, attributes: true };
}

function installMutationGuard(root, spec, snapshots, undos) {
  const doc = docOf(root);
  if (!doc || typeof MutationObserver !== "function") return () => {};
  let timer = null;
  let burstStart = 0;
  let stopped = false;
  let queued = [];
  const media =
    doc.defaultView && typeof doc.defaultView.matchMedia === "function"
      ? doc.defaultView.matchMedia("(prefers-color-scheme: dark)")
      : null;

  const run = (records) => {
    if (stopped) return;
    observer.disconnect();
    if (media && media.removeEventListener) {
      try {
        media.removeEventListener("change", onMedia);
      } catch {
        /* ignore */
      }
    }
    const err = runGuardCheck(root, spec, snapshots, records);
    if (err) {
      undoAll(undos);
      recordFailOpen(err, spec.id);
      stop();
      return;
    }
    startObserving();
  };

  const schedule = (records) => {
    if (stopped) return;
    queued = queued.concat(records || []);
    if (backstopsPaused) return;
    const now = Date.now();
    if (!burstStart) burstStart = now;
    if (timer) clearTimeout(timer);
    const elapsed = now - burstStart;
    const delay = Math.max(0, Math.min(32, GUARD_MAX_WAIT_MS - elapsed));
    timer = setTimeout(() => {
      timer = null;
      burstStart = 0;
      const batch = queued;
      queued = [];
      run(batch);
    }, delay);
  };
  const flushQueued = () => {
    if (stopped || backstopsPaused) return;
    if (timer) clearTimeout(timer);
    timer = null;
    burstStart = 0;
    if (queued.length === 0) return;
    const batch = queued;
    queued = [];
    run(batch);
  };
  const kick = () => {
    if (stopped || backstopsPaused) return;
    schedule([]);
  };
  guardFlushers.push(flushQueued);
  guardKickers.push(kick);

  const observer = new MutationObserver((records) => schedule(records));
  const onMedia = () => schedule([]);

  const startObserving = () => {
    if (stopped) return;
    const node = doc.documentElement || root;
    try {
      observer.observe(node, observeOptions());
    } catch {
      /* closed document */
    }
    if (media && media.addEventListener) {
      try {
        media.addEventListener("change", onMedia);
      } catch {
        /* ignore */
      }
    }
  };

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    observer.disconnect();
    const fi = guardFlushers.indexOf(flushQueued);
    if (fi >= 0) guardFlushers.splice(fi, 1);
    const ki = guardKickers.indexOf(kick);
    if (ki >= 0) guardKickers.splice(ki, 1);
    releaseCssomWatch();
    if (media && media.removeEventListener) {
      try {
        media.removeEventListener("change", onMedia);
      } catch {
        /* ignore */
      }
    }
    removeGuard(stop);
  };

  ensureCssomWatch();
  startObserving();
  return stop;
}

function finishApply(scope, spec, snapshots, undos, opsStatus) {
  const contrastErr = specContrastError(scope, spec, "apply");
  if (contrastErr) {
    undoAll(undos);
    return { ok: false, error: contrastErr, ops: opsStatus };
  }
  const monoErr = monotonicityViolation(scope, snapshots);
  if (monoErr) {
    undoAll(undos);
    return { ok: false, error: monoErr, ops: opsStatus };
  }
  const coverErr = overlayCoverageViolation(scope, spec, snapshots);
  if (coverErr) {
    undoAll(undos);
    return { ok: false, error: coverErr, ops: opsStatus };
  }
  const existing = guardsBySpecId.get(spec.id);
  if (undos.length === 0 && existing) {
    return { ok: true, ops: opsStatus };
  }
  const merged = [...(existing && existing.undos ? existing.undos : []), ...undos];
  if (existing) {
    try {
      existing.stop();
    } catch {
      /* replace */
    }
  }
  const stopGuard = installMutationGuard(scope, spec, snapshots, merged);
  activeGuards.push(stopGuard);
  guardsBySpecId.set(spec.id, { stop: stopGuard, undos: merged });
  return { ok: true, ops: opsStatus };
}

function flushPendingBackstops() {
  const pending = pendingBackstops.splice(0);
  for (const item of pending) {
    const result = finishApply(item.scope, item.spec, item.snapshots, item.undos, item.opsStatus);
    if (!result.ok) recordFailOpen(result.error, item.spec.id);
  }
}

export function setTestBackstopsPaused(paused) {
  if (!testHooksAllowed()) return false;
  backstopsPaused = Boolean(paused);
  if (!backstopsPaused) {
    flushPendingBackstops();
    for (const flush of [...guardFlushers]) flush();
    kickAllGuards();
  }
  return true;
}

/** Apply a validated spec. On throw or a required-selector miss, undo so the page is untouched. */
export function applyPatchSpec(input, root) {
  const opsStatus = [];
  try {
    const parsed = parsePatchSpec(input);
    if (!parsed.ok) return { ok: false, error: parsed.error, ops: opsStatus };
    const scope = root ?? (typeof document === "undefined" ? null : document);
    if (!scope) return { ok: false, error: "no document", ops: opsStatus };
    const collected = collectWatchElements(scope, parsed.spec);
    if (collected.error) return { ok: false, error: collected.error, ops: opsStatus };
    const snapshots = attachOverlayHits(
      scope,
      parsed.spec,
      collected.elements.map(snapshotA11y),
    );
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
      if (backstopsPaused && testHooksAllowed()) {
        pendingBackstops.push({
          scope,
          spec: parsed.spec,
          snapshots,
          undos,
          opsStatus,
        });
        return { ok: true, ops: opsStatus, paused: true };
      }
      return finishApply(scope, parsed.spec, snapshots, undos, opsStatus);
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
  window.LiftRuntime = {
    applyPatchSpec,
    validatePatchSpec,
    setTestBackstopsPaused,
  };
  Object.defineProperty(window.LiftRuntime, "resetRuntimeGuards", {
    enumerable: true,
    get() {
      if (!testHooksAllowed()) return undefined;
      return resetRuntimeGuards;
    },
  });
}
