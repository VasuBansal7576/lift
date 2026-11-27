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
  hashKey,
  isLabelableTextControl,
  isSafeInsertHtml,
  localTagName,
  mountKeyFor,
  parsePatchSpec,
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

function applySetAttribute(root, op, index) {
  const found = queryOne(root, op.selector);
  if (found.error) return miss(index, op.selector, found.error);
  const el = found.el;
  if (!(el instanceof Element)) return miss(index, op.selector);
  if (elementForbiddenAsTextOrTagHost(el)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  const attrName = op.name.toLowerCase();
  if (attrName.startsWith("data-lift-")) {
    return { status: "miss", error: `ops[${index}] disallowed attribute` };
  }
  if (attrName === "type") {
    const tag = localTagName(el);
    if (tag === "input" || tag === "select" || tag === "textarea" || op.value.toLowerCase() === "hidden") {
      return { status: "miss", error: `ops[${index}] disallowed attribute` };
    }
  }
  if (attributeWouldHideInteractive(op.name, op.value, el)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  if (attrName === "for") {
    const target = resolveForTarget(root, op.value.trim());
    if (!isLabelableTextControl(target)) {
      return { status: "miss", error: `ops[${index}] target is not allowlisted` };
    }
  }
  if (attrName === "class") {
    const tokens = op.value.trim().split(/\s+/).filter(Boolean);
    const added = tokens.filter((token) => !el.classList.contains(token));
    if (added.length === 0) return noop();
    for (const token of added) el.classList.add(token);
    return applied(() => {
      for (const token of added) el.classList.remove(token);
    });
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
  if (elementForbiddenAsTextOrTagHost(el)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  if (elementHasElementChildren(el) || elementHasVoidOrControlDescendant(el)) {
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

function effectiveBackgroundRgb(el) {
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

function cssMatchesViolateHostsOrContrast(root, op) {
  const scope = "querySelectorAll" in root ? root : docOf(root);
  for (const rule of op.rules || []) {
    let matches;
    try {
      matches = scope.querySelectorAll(serializeSelectorForQuery(rule.selector));
    } catch {
      return "invalid selector";
    }
    if (matches.length > CSS_MATCH_LIMIT) return "too many matches";
    for (const el of matches) {
      if (elementIsPageContainer(el) || elementForbiddenAsTextOrTagHost(el)) {
        return "target is not allowlisted";
      }
      const fg = parseComputedRgb(getComputedStyle(el).color);
      if (!fg || fg.alpha < 0.99) continue;
      const bg = effectiveBackgroundRgb(el);
      const min = largeTextThreshold(el);
      if (contrastRatio(fg.rgb, bg) < min) return "contrast is not allowlisted";
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
  if (hint) hint.replaceWith(label);
  else input.insertAdjacentElement("beforebegin", label);
  return applied(() => {
    if (hint) label.replaceWith(hint);
    else label.remove();
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
  if (elementForbiddenAsTextOrTagHost(el)) {
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
  if (elementForbiddenAsTextOrTagHost(el)) {
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

function overlayAttributes(el, attrs) {
  const undoAttrs = [];
  for (const [name, value] of Object.entries(attrs)) {
    if (name.toLowerCase() === "class") {
      const tokens = String(value).trim().split(/\s+/).filter(Boolean);
      const added = tokens.filter((token) => !el.classList.contains(token));
      if (added.length === 0) continue;
      for (const token of added) el.classList.add(token);
      undoAttrs.push(() => {
        for (const token of added) el.classList.remove(token);
      });
      continue;
    }
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
    return overlayAttributes(existing, op.attributes || {});
  }
  const found = queryOne(root, op.selector);
  if (found.error) return miss(index, op.selector, found.error);
  const el = found.el;
  if (!(el instanceof Element)) return miss(index, op.selector);
  if (elementForbiddenAsTextOrTagHost(el)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  if (elementHasVoidOrControlDescendant(el) || elementHasInteractiveDescendant(el)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  if (el.getAttribute("data-lift-replaced") === key) {
    if (!forTargetAllowed(root, op)) {
      return { status: "miss", error: `ops[${index}] target is not allowlisted` };
    }
    return overlayAttributes(el, op.attributes || {});
  }
  if (el.tagName.toLowerCase() === op.tag.toLowerCase()) {
    if (!forTargetAllowed(root, op)) {
      return { status: "miss", error: `ops[${index}] target is not allowlisted` };
    }
    const hadMarker = el.hasAttribute("data-lift-replaced");
    const prevMarker = el.getAttribute("data-lift-replaced");
    el.setAttribute("data-lift-replaced", key);
    const overlay = overlayAttributes(el, op.attributes || {});
    return applied(() => {
      if (overlay.status === "applied") overlay.undo();
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
    next.setAttribute(name, value);
  }
  next.setAttribute("data-lift-replaced", key);
  while (el.firstChild) next.appendChild(el.firstChild);
  const rootOriginal = replacementRoot.get(el) ?? el;
  replacementRoot.set(next, rootOriginal);
  el.replaceWith(next);
  const stopForward = forwardUiEvents(next, rootOriginal);
  return applied(() => {
    stopForward();
    replacementRoot.delete(next);
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
  if (elementForbiddenAsTextOrTagHost(target)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  const doc = docOf(root);
  if (!isSafeInsertHtml(op.html, doc)) {
    return { status: "miss", error: `ops[${index}] html is not allowlisted` };
  }
  const fragment = sanitizeInsertHtml(op.html, doc);
  if (!fragment) return { status: "miss", error: `ops[${index}] html is not allowlisted` };
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
  const hadOpen = panel.classList.contains("is-open");
  const onClick = (event) => {
    if (event.target !== trigger) return;
    const open = panel.classList.toggle("is-open");
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
    if (!hadOpen) panel.classList.remove("is-open");
    else panel.classList.add("is-open");
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

/** Apply a validated spec. On throw or a required-selector miss, undo so the page is untouched. */
export function applyPatchSpec(input, root) {
  const opsStatus = [];
  try {
    const parsed = parsePatchSpec(input);
    if (!parsed.ok) return { ok: false, error: parsed.error, ops: opsStatus };
    const scope = root ?? (typeof document === "undefined" ? null : document);
    if (!scope) return { ok: false, error: "no document", ops: opsStatus };
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
  window.LiftRuntime = { applyPatchSpec, validatePatchSpec };
}
