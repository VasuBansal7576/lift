const FLAG_NAME = "checkout_a11y";

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

function applyVariant(variant) {
  const treatment = variant === "treatment";
  document.body.classList.toggle("fix-hover", treatment);
  document.body.classList.toggle("fix-labels", treatment);
  document.body.classList.toggle("fix-contrast", treatment);
  document.body.dataset.variant = variant;
  document.getElementById("flag-status").textContent =
    `Flagsmith ${FLAG_NAME}=${variant}`;

  const trigger = document.getElementById("shop-trigger");
  const menu = document.getElementById("shop-menu");
  if (treatment) {
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
  if (treatment) {
    const button = document.createElement("button");
    button.type = "button";
    button.id = "cart-icon";
    button.className = "icon-btn";
    button.setAttribute("aria-label", "View cart and check out");
    button.textContent = "👜";
    cart.replaceWith(button);
    button.addEventListener("click", openCheckout);
  } else {
    cart.addEventListener("click", openCheckout);
  }

  if (treatment) {
    for (const [id, label] of [
      ["email", "Email"],
      ["card-name", "Name on card"],
      ["card-number", "Card number"],
      ["card-exp", "Expiry"],
      ["card-cvc", "CVC"],
    ]) {
      const input = document.getElementById(id);
      const tag = document.createElement("label");
      tag.setAttribute("for", id);
      tag.textContent = label;
      input.removeAttribute("data-unlabeled");
      input.parentElement.querySelector(".visible-hint")?.replaceWith(tag);
    }
  }

  const pay = document.getElementById("place-order");
  if (treatment) {
    const button = document.createElement("button");
    button.type = "button";
    button.id = "place-order";
    button.className = "place-order";
    button.textContent = "Place order";
    pay.replaceWith(button);
    button.addEventListener("click", submitOrder);
  } else {
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

async function initFromFlagsmith(config) {
  if (!config?.flagsmithEnvironmentKey) {
    throw new Error("Missing FLAGSMITH_ENVIRONMENT_KEY");
  }
  const identity =
    params().get("lift_identity") ||
    crypto.randomUUID();
  const { default: flagsmith } = await import(
    "https://cdn.jsdelivr.net/npm/flagsmith@12.4.0/+esm"
  );
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
  applyVariant(variant);
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
  if (mock === "control" || mock === "treatment") {
    applyVariant(mock);
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
