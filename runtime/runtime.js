/**
 * Declarative patch runtime. Fail-open: invalid specs and thrown/missed ops leave the page as it was.
 * Validation lives in ./patch-rules.js (shared with the TypeScript wrapper).
 */

import {
  cssKey,
  hashKey,
  isSafeInsertHtml,
  mountKeyFor,
  parsePatchSpec,
  sanitizeInsertHtml,
} from "./patch-rules.js";

export {
  isAllowedAttributeName,
  isSafeAttributeValue,
  isSafeCss,
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

function applySetAttribute(root, op, index) {
  const found = queryOne(root, op.selector);
  if (found.error) return miss(index, op.selector, found.error);
  const el = found.el;
  if (!(el instanceof Element)) return miss(index, op.selector);
  if (el.getAttribute(op.name) === op.value) return noop();
  const had = el.hasAttribute(op.name);
  const prev = el.getAttribute(op.name);
  el.setAttribute(op.name, op.value);
  return applied(() => {
    if (!had) el.removeAttribute(op.name);
    else el.setAttribute(op.name, prev ?? "");
  });
}

const FORBIDDEN_TEXT_HOSTS = new Set(["STYLE", "SCRIPT", "TEMPLATE", "NOSCRIPT"]);

function applySetText(root, op, index) {
  const found = queryOne(root, op.selector);
  if (found.error) return miss(index, op.selector, found.error);
  const el = found.el;
  if (!(el instanceof Element)) return miss(index, op.selector);
  if (FORBIDDEN_TEXT_HOSTS.has(el.tagName)) {
    return { status: "miss", error: `ops[${index}] target is not allowlisted` };
  }
  const prevChildren = [...el.childNodes];
  if (el.textContent === op.text) return noop();
  el.textContent = op.text;
  return applied(() => {
    el.replaceChildren(...prevChildren);
  });
}

function applyInjectCss(root, op) {
  const doc = docOf(root);
  const id = cssKey(op);
  const existing = doc.getElementById(id);
  if (existing && existing.tagName === "STYLE") {
    const prev = existing.textContent ?? "";
    if (prev === op.css) return noop();
    existing.textContent = op.css;
    return applied(() => {
      existing.textContent = prev;
    });
  }
  const style = doc.createElement("style");
  style.id = id;
  style.setAttribute("data-lift-css", "1");
  style.textContent = op.css;
  const parent = doc.head ?? doc.documentElement;
  parent.appendChild(style);
  return applied(() => {
    style.remove();
  });
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
  if (el.getAttribute("data-lift-enter") === "1") return noop();
  const onKey = (event) => {
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

function forwardUiEvents(from, to) {
  const nativeActivator = from.tagName === "BUTTON" || from.tagName === "A";
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

function overlayAttributes(el, attrs) {
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
  if (undoAttrs.length === 0) return noop();
  return applied(() => {
    for (const undo of undoAttrs.reverse()) undo();
  });
}

function applyReplaceTag(root, op, index) {
  const key = replaceTagKey(op);
  const existing = findReplaced(root, key);
  if (existing) return overlayAttributes(existing, op.attributes || {});
  const found = queryOne(root, op.selector);
  if (found.error) return miss(index, op.selector, found.error);
  const el = found.el;
  if (!(el instanceof Element)) return miss(index, op.selector);
  if (el.getAttribute("data-lift-replaced") === key) {
    return overlayAttributes(el, op.attributes || {});
  }
  if (el.tagName.toLowerCase() === op.tag.toLowerCase()) {
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

function applyOp(root, op, index) {
  switch (op.op) {
    case "setAttribute":
      return applySetAttribute(root, op, index);
    case "setText":
      return applySetText(root, op, index);
    case "injectCSS":
      return applyInjectCss(root, op);
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
