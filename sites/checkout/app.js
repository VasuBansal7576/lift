const FLAG_NAME = "checkout_a11y";
const SDK_URL = "https://cdn.jsdelivr.net/npm/@flagsmith/flagsmith@12.4.0/+esm";

const BARRIER_FLAGS = {
  hover_menu: "a11y_hover_menu",
  unlabeled_icon: "a11y_unlabeled_icon",
  div_button: "a11y_div_button",
  missing_labels: "a11y_missing_labels",
  unlabeled_terms: "a11y_unlabeled_terms",
  low_contrast: "a11y_low_contrast",
};

/** @typedef {"control" | "treatment"} Variant */

function params() {
  return new URLSearchParams(location.search);
}

async function loadConfig() {
  try {
    const res = await fetch("./config.json", { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function setStatus(text, isError = false) {
  const el = document.getElementById("flag-status");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("flagsmith-error", isError);
}

function allFixes(on) {
  return {
    hover_menu: on,
    unlabeled_icon: on,
    div_button: on,
    missing_labels: on,
    unlabeled_terms: on,
    low_contrast: on,
  };
}

function applyFixes(fixes, sourceLabel) {
  document.body.classList.toggle("fix-hover", Boolean(fixes.hover_menu));
  document.body.classList.toggle("fix-labels", Boolean(fixes.missing_labels));
  document.body.classList.toggle("fix-contrast", Boolean(fixes.low_contrast));
  const bundledOn = Object.values(fixes).every(Boolean);
  document.body.dataset.variant = bundledOn ? "treatment" : "control";
  setStatus(sourceLabel);

  const trigger = document.getElementById("shop-trigger");
  const menu = document.getElementById("shop-menu");
  if (fixes.hover_menu && trigger && trigger.tagName !== "BUTTON") {
    const button = document.createElement("button");
    button.type = "button";
    button.id = "shop-trigger";
    button.className = "hover-trigger";
    button.textContent = "Shop";
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", "shop-menu");
    trigger.replaceWith(button);
    menu.classList.remove("is-open");
    button.addEventListener("click", () => {
      const open = !menu.classList.contains("is-open");
      menu.classList.toggle("is-open", open);
      button.setAttribute("aria-expanded", String(open));
    });
  }

  const cart = document.getElementById("cart-icon");
  if (fixes.unlabeled_icon && cart) {
    if (!cart.getAttribute("aria-label")) {
      cart.setAttribute("aria-label", "View cart and check out");
      if (!cart.textContent) cart.textContent = "👜";
    }
    if (!cart.dataset.bound) {
      cart.dataset.bound = "1";
      cart.addEventListener("click", openCheckout);
    }
  } else if (cart && !cart.dataset.bound) {
    cart.dataset.bound = "1";
    cart.addEventListener("click", openCheckout);
  }

  if (fixes.missing_labels) {
    for (const [id, label] of [
      ["email", "Email"],
      ["card-name", "Name on card"],
      ["card-number", "Card number"],
      ["card-exp", "Expiry"],
      ["card-cvc", "CVC"],
    ]) {
      const input = document.getElementById(id);
      if (!input || input.hasAttribute("data-labelled")) continue;
      const tag = document.createElement("label");
      tag.setAttribute("for", id);
      tag.textContent = label;
      input.removeAttribute("data-unlabeled");
      input.setAttribute("data-labelled", "1");
      input.parentElement.querySelector(".visible-hint")?.replaceWith(tag);
    }
  }

  if (fixes.unlabeled_terms) {
    const terms = document.getElementById("terms");
    const copy = document.getElementById("terms-copy");
    if (terms && copy && copy.tagName !== "LABEL") {
      const label = document.createElement("label");
      label.setAttribute("for", "terms");
      label.id = "terms-copy";
      label.textContent = copy.textContent ?? "";
      copy.replaceWith(label);
    }
  }

  const pay = document.getElementById("place-order");
  if (fixes.div_button && pay && pay.tagName !== "BUTTON") {
    const button = document.createElement("button");
    button.type = "button";
    button.id = "place-order";
    button.className = "place-order";
    button.textContent = "Place order";
    pay.replaceWith(button);
    button.addEventListener("click", submitOrder);
  } else if (pay && !pay.dataset.bound) {
    pay.dataset.bound = "1";
    pay.addEventListener("click", submitOrder);
  }
}

function openCheckout() {
  const section = document.getElementById("checkout");
  section.hidden = false;
  section.scrollIntoView({ block: "start" });
}

function showError(message) {
  const el = document.getElementById("form-error");
  el.hidden = false;
  el.textContent = message;
}

function fieldValue(id) {
  return document.getElementById(id).value.trim();
}

function submitOrder() {
  const email = fieldValue("email");
  const name = fieldValue("card-name");
  const number = fieldValue("card-number");
  const exp = fieldValue("card-exp");
  const cvc = fieldValue("card-cvc");
  const terms = document.getElementById("terms").checked;
  if (!email || !name || !number || !exp || !cvc) {
    showError("Complete every field to place the order.");
    return;
  }
  if (!terms) {
    showError("Agree to the terms of sale to continue.");
    return;
  }
  document.getElementById("checkout-form").hidden = true;
  document.getElementById("form-error").hidden = true;
  const confirmation = document.getElementById("confirmation");
  confirmation.hidden = false;
  window.__LIFT_CONVERTED = true;
  document.body.dataset.converted = "true";
  window.dispatchEvent(new CustomEvent("lift:converted"));
}

document.getElementById("checkout-link")?.addEventListener("click", (event) => {
  event.preventDefault();
  openCheckout();
});

function flagIsTreatment(flagsmith, name) {
  try {
    const value = flagsmith.getValue(name);
    return value === "treatment";
  } catch {
    return false;
  }
}

function fixesFromFlagsmith(flagsmith, bundledVariant) {
  const bundled = bundledVariant === "treatment";
  const fixes = {};
  for (const [id, flag] of Object.entries(BARRIER_FLAGS)) {
    fixes[id] = bundled || flagIsTreatment(flagsmith, flag);
  }
  return fixes;
}

async function initFromFlagsmith(config) {
  if (!config?.flagsmithEnvironmentKey) {
    throw new Error("Missing FLAGSMITH_ENVIRONMENT_KEY");
  }
  const identity =
    params().get("lift_identity") ||
    crypto.randomUUID();
  const { default: flagsmith } = await import(SDK_URL);
  await flagsmith.init({
    environmentID: config.flagsmithEnvironmentKey,
    api: config.flagsmithApiUrl,
    identity,
    traits: {
      simulated: false,
      site: "checkout",
    },
    enableEvents: true,
    eventProcessorConfig: config.flagsmithEventsUrl
      ? { eventsApiUrl: config.flagsmithEventsUrl }
      : undefined,
  });
  const flag = flagsmith.getExperimentFlag(config.flagName || FLAG_NAME);
  const variant =
    flag?.variant === "treatment" || flag?.value === "treatment"
      ? "treatment"
      : "control";
  applyFixes(
    fixesFromFlagsmith(flagsmith, variant),
    `Flagsmith ${config.flagName || FLAG_NAME}=${variant}`,
  );
  window.addEventListener("lift:converted", async () => {
    flagsmith.trackEvent(config.metricEvent || "checkout_completed", {
      traits: { converted: true, simulated: false, site: "checkout" },
    });
    await flagsmith.setTrait("converted", true);
    await flagsmith.flushEvents();
  });
  window.addEventListener("pagehide", () => {
    void flagsmith.flushEvents();
  });
}

async function main() {
  const mock = params().get("lift_variant");
  const config = await loadConfig();
  const allowMock = Boolean(config?.allowMock);
  if (allowMock && (mock === "control" || mock === "treatment")) {
    applyFixes(allFixes(mock === "treatment"), "URL override (no Flagsmith)");
    return;
  }
  try {
    await initFromFlagsmith(config ?? {});
  } catch (err) {
    setStatus(
      `Flagsmith is required for variant assignment (${err instanceof Error ? err.message : err}).`,
      true,
    );
  }
}

void main();
