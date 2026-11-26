function setStatus(text, isError = false) {
  const el = document.getElementById("flag-status");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("flagsmith-error", isError);
}

function convert() {
  const form = document.getElementById("lift-form");
  if (form) form.hidden = true;
  const confirmation = document.querySelector("[data-lift-confirm]");
  if (confirmation) confirmation.hidden = false;
  window.__LIFT_CONVERTED = true;
  document.body.dataset.converted = "true";
  window.dispatchEvent(new CustomEvent("lift:converted"));
}

function showError(message) {
  const el = document.getElementById("form-error");
  if (!el) return;
  el.hidden = false;
  el.textContent = message;
}

function requiredFieldsFilled() {
  const fields = [...document.querySelectorAll("[data-lift-field]")];
  return fields.every((el) => {
    if (!(el instanceof HTMLInputElement)) return true;
    return el.value.trim().length > 0;
  });
}

function termsOk() {
  const terms = document.querySelector("[data-lift-terms]");
  if (!(terms instanceof HTMLInputElement)) return true;
  return terms.checked;
}

function showFrictionThen(next) {
  const step = document.querySelector("[data-friction-step]");
  if (!(step instanceof HTMLElement) || !document.body.classList.contains("fix-friction")) {
    next();
    return;
  }
  step.hidden = false;
  document.body.dataset.friction = "true";
  const confirm = step.querySelector("[data-lift-friction-confirm]");
  if (confirm && !confirm.dataset.bound) {
    confirm.dataset.bound = "1";
    confirm.addEventListener("click", () => {
      step.hidden = true;
      next();
    });
  }
}

function submitFlow() {
  if (!requiredFieldsFilled()) {
    showError("Complete every field to continue.");
    return;
  }
  if (!termsOk()) {
    showError("Agree to continue.");
    return;
  }
  showFrictionThen(convert);
}

function bindSubmit(el) {
  if (!el || el.dataset.bound) return;
  el.dataset.bound = "1";
  el.addEventListener("click", (event) => {
    event.preventDefault();
    submitFlow();
  });
}

function bindOpeners() {
  for (const el of document.querySelectorAll("[data-lift-open]")) {
    if (el.dataset.bound) continue;
    el.dataset.bound = "1";
    el.addEventListener("click", (event) => {
      event.preventDefault();
      const panel = document.getElementById("lift-panel");
      if (panel) {
        panel.hidden = false;
        panel.scrollIntoView({ block: "start" });
      }
    });
  }
}

function fixHoverMenu() {
  const trigger = document.querySelector("[data-barrier='hover_menu'] .hover-trigger, .hover-trigger");
  const menu = document.querySelector(".hover-menu");
  if (!trigger || !menu || trigger.tagName === "BUTTON") return;
  const button = document.createElement("button");
  button.type = "button";
  button.id = trigger.id || "nav-trigger";
  button.className = trigger.className;
  button.textContent = trigger.textContent ?? "Menu";
  button.setAttribute("aria-expanded", "false");
  if (menu.id) button.setAttribute("aria-controls", menu.id);
  trigger.replaceWith(button);
  menu.classList.remove("is-open");
  button.addEventListener("click", () => {
    const open = !menu.classList.contains("is-open");
    menu.classList.toggle("is-open", open);
    button.setAttribute("aria-expanded", String(open));
  });
}

function fixUnlabeledIcons() {
  for (const el of document.querySelectorAll("[data-barrier='unlabeled_icon']")) {
    const name = el.getAttribute("data-lift-name") || "Continue";
    if (!el.getAttribute("aria-label")) el.setAttribute("aria-label", name);
    if (!el.textContent?.trim()) el.textContent = el.getAttribute("data-lift-glyph") || "";
  }
}

function fixLabels() {
  for (const input of document.querySelectorAll("[data-unlabeled]")) {
    if (!(input instanceof HTMLElement) || input.hasAttribute("data-labelled")) continue;
    const id = input.id;
    const labelText = input.getAttribute("data-lift-label") || id;
    if (!id) continue;
    const tag = document.createElement("label");
    tag.setAttribute("for", id);
    tag.textContent = labelText;
    input.removeAttribute("data-unlabeled");
    input.setAttribute("data-labelled", "1");
    input.parentElement?.querySelector(".visible-hint")?.replaceWith(tag);
  }
}

function fixTerms() {
  const terms = document.querySelector("[data-lift-terms]");
  const copy = document.querySelector("[data-lift-terms-copy]");
  if (!(terms instanceof HTMLElement) || !copy || copy.tagName === "LABEL") return;
  const label = document.createElement("label");
  if (terms.id) label.setAttribute("for", terms.id);
  label.id = copy.id;
  label.setAttribute("data-lift-terms-copy", "");
  label.textContent = copy.textContent ?? "";
  copy.replaceWith(label);
}

function fixDivButton() {
  const pay = document.querySelector("[data-barrier='div_button']");
  if (!pay || pay.tagName === "BUTTON") {
    bindSubmit(pay);
    return;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.id = pay.id;
  button.className = "place-order";
  button.setAttribute("data-lift-submit", "");
  button.textContent = pay.getAttribute("data-lift-submit-label") || "Continue";
  pay.replaceWith(button);
  bindSubmit(button);
}

function fixAutocomplete() {
  for (const input of document.querySelectorAll("[data-lift-field][data-lift-autocomplete]")) {
    if (input instanceof HTMLInputElement) {
      const value = input.getAttribute("data-lift-autocomplete") ?? "on";
      input.setAttribute("autocomplete", value);
    }
  }
}

function bindSearch() {
  const searchBtn = document.querySelector("[data-lift-search]");
  const query = document.querySelector("[data-lift-query]");
  const result = document.querySelector("[data-lift-result]");
  const run = () => {
    if (query instanceof HTMLInputElement && query.value.trim() && result) {
      result.hidden = false;
      const panel = document.getElementById("lift-panel");
      if (panel) panel.hidden = false;
    }
  };
  if (searchBtn && !searchBtn.dataset.searchBound) {
    searchBtn.dataset.searchBound = "1";
    searchBtn.addEventListener("click", run);
  }
  if (query && !query.dataset.searchBound) {
    query.dataset.searchBound = "1";
    query.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        run();
      }
    });
  }
}

export function applyFixes(fixes, sourceLabel) {
  document.body.classList.toggle("fix-hover", Boolean(fixes.hover_menu));
  document.body.classList.toggle("fix-labels", Boolean(fixes.missing_labels));
  document.body.classList.toggle("fix-contrast", Boolean(fixes.low_contrast));
  document.body.classList.toggle("fix-friction", Boolean(fixes.extra_confirm));
  const flags = Object.values(fixes);
  const bundledOn = flags.length > 0 && flags.every(Boolean);
  document.body.dataset.variant = bundledOn ? "treatment" : "control";
  if (fixes.extra_confirm) document.body.dataset.friction = "true";
  setStatus(sourceLabel);

  if (fixes.hover_menu) fixHoverMenu();
  if (fixes.unlabeled_icon) fixUnlabeledIcons();
  if (fixes.missing_labels) fixLabels();
  if (fixes.unlabeled_terms) fixTerms();
  if (fixes.autocomplete_off) fixAutocomplete();
  if (fixes.div_button) {
    fixDivButton();
  } else {
    bindSubmit(document.querySelector("[data-lift-submit], [data-barrier='div_button']"));
  }
  bindSubmit(document.querySelector("[data-lift-submit]"));
  bindOpeners();
  bindSearch();
}

export { setStatus, convert, submitFlow };
