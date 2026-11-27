/** @vitest-environment happy-dom */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT } from "../../agent/src/config.ts";
import { applyPatchSpec, validatePatchSpec } from "../../runtime/runtime.js";

const CHECKOUT_HTML = `
  <header>
    <div class="hover-nav">
      <span class="hover-trigger" id="shop-trigger">Shop</span>
      <div class="hover-menu" id="shop-menu"><a href="#checkout" id="checkout-link">Checkout</a></div>
    </div>
    <button type="button" id="cart-icon" class="icon-btn"></button>
  </header>
  <form>
    <p>
      <span class="visible-hint" id="email-hint">Email</span>
      <input id="email" name="email" type="email" data-unlabeled>
    </p>
    <p>
      <span class="visible-hint">Name on card</span>
      <input id="card-name" data-unlabeled>
    </p>
    <p>
      <span class="visible-hint">Card number</span>
      <input id="card-number" data-unlabeled>
    </p>
    <p>
      <span class="visible-hint">Expiry</span>
      <input id="card-exp" data-unlabeled>
    </p>
    <p>
      <span class="visible-hint">CVC</span>
      <input id="card-cvc" data-unlabeled>
    </p>
    <p class="contrast-fail">
      <input id="terms" type="checkbox">
      <span id="terms-copy">I agree to the terms of sale and understand this order is final.</span>
    </p>
    <div id="place-order" class="div-pay" data-barrier="div_button" style="color: red">💳<span class="glyph">x</span></div>
  </form>
`;

function checkoutSpec(): unknown {
  return JSON.parse(readFileSync(resolve(ROOT, "runtime/checkout-treatment.json"), "utf8"));
}

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("validatePatchSpec (runtime)", () => {
  it("matches the TypeScript parser on the checkout spec", () => {
    const parsed = validatePatchSpec(checkoutSpec());
    expect(parsed.ok).toBe(true);
  });

  it("rejects script injection", () => {
    expect(
      validatePatchSpec({
        id: "bad",
        version: 0,
        ops: [{ op: "insertHTML", selector: "body", position: "append", html: "<img src=x onerror=alert(1)>" }],
      }).ok,
    ).toBe(false);
  });
});

describe("applyPatchSpec ops", () => {
  it("applies the checkout treatment spec idempotently", () => {
    document.body.innerHTML = CHECKOUT_HTML;
    const spec = checkoutSpec();
    expect(applyPatchSpec(spec).ok).toBe(true);
    expect(applyPatchSpec(spec).ok).toBe(true);

    const shop = document.getElementById("shop-trigger");
    expect(shop?.tagName).toBe("BUTTON");
    expect(shop?.getAttribute("type")).toBe("button");
    expect(shop?.getAttribute("aria-expanded")).toBe("false");
    expect(shop?.textContent).toBe("Shop");

    const cart = document.getElementById("cart-icon");
    expect(cart?.getAttribute("aria-label")).toBe("View cart and check out");
    expect(cart?.textContent).toBe("👜");

    expect(document.querySelector('label[for="email"]')?.textContent).toBe("Email");
    expect(document.getElementById("email")?.getAttribute("data-labelled")).toBe("1");
    expect(document.getElementById("email-hint")).toBeNull();

    const terms = document.getElementById("terms-copy");
    expect(terms?.tagName).toBe("LABEL");
    expect(terms?.getAttribute("for")).toBe("terms");

    const pay = document.getElementById("place-order");
    expect(pay?.tagName).toBe("BUTTON");
    expect(pay?.textContent).toBe("Place order");
    expect(pay?.className).toBe("place-order");

    expect(document.querySelectorAll("[data-lift-css]")).toHaveLength(1);
  });

  it("replaceTag moves children, copies data-* / style, and forwards click to the original node", () => {
    document.body.innerHTML = `<div id="place-order" class="div-pay" data-barrier="div_button" style="color: red">💳<span id="kid">x</span></div>`;
    const original = document.getElementById("place-order");
    let clicks = 0;
    original?.addEventListener("click", () => {
      clicks += 1;
    });
    const result = applyPatchSpec({
      id: "replace",
      version: 0,
      ops: [{ op: "replaceTag", selector: "#place-order", tag: "button", attributes: { type: "button" } }],
    });
    expect(result.ok).toBe(true);
    const next = document.getElementById("place-order");
    expect(next?.tagName).toBe("BUTTON");
    expect(next?.getAttribute("data-barrier")).toBe("div_button");
    expect(next?.getAttribute("style")).toBe("color: red");
    expect(document.getElementById("kid")?.textContent).toBe("x");
    expect(document.getElementById("kid")?.parentElement).toBe(next);
    next?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicks).toBe(1);
  });

  it("wrapLabel only replaces a previous-sibling hint and skips already-labelled inputs", () => {
    document.body.innerHTML = `
      <p>
        <span class="visible-hint" id="other-hint">Other</span>
        <span id="between">x</span>
        <input id="email" data-unlabeled="yes">
      </p>
      <p>
        <label for="named">Name</label>
        <input id="named">
      </p>
      <p>
        <input id="aria" aria-label="Phone">
      </p>
    `;
    const result = applyPatchSpec({
      id: "wrap",
      version: 0,
      ops: [
        { op: "wrapLabel", selector: "#email", text: "Email" },
        { op: "wrapLabel", selector: "#named", text: "Dup" },
        { op: "wrapLabel", selector: "#aria", text: "Dup" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(document.getElementById("other-hint")).not.toBeNull();
    expect(document.querySelector('label[for="email"]')?.textContent).toBe("Email");
    expect(document.getElementById("email")?.previousElementSibling?.tagName).toBe("LABEL");
    expect(document.querySelectorAll('label[for="named"]')).toHaveLength(1);
    expect(document.querySelectorAll('label[for="aria"]')).toHaveLength(0);

    const originalCreate = document.createElement.bind(document);
    document.createElement = ((tag: string) => {
      if (tag === "style") throw new Error("style boom");
      return originalCreate(tag);
    }) as typeof document.createElement;
    try {
      document.body.innerHTML = `<p><span class="visible-hint">Email</span><input id="email" data-unlabeled="yes"></p>`;
      const rolled = applyPatchSpec({
        id: "wrap-undo-2",
        version: 0,
        ops: [
          { op: "wrapLabel", selector: "#email", text: "Email" },
          { op: "injectCSS", css: "p { color: red; }" },
        ],
      });
      expect(rolled.ok).toBe(false);
      const input = document.getElementById("email");
      expect(input?.getAttribute("data-unlabeled")).toBe("yes");
      expect(input?.hasAttribute("data-labelled")).toBe(false);
      expect(document.querySelector(".visible-hint")).not.toBeNull();
    } finally {
      document.createElement = originalCreate;
    }
  });

  it("makeFocusable, bindEnterToClick, and insertHTML at a mount node", () => {
    document.body.innerHTML = `<div id="host"><span id="chip">Pay</span></div>`;
    const spec = {
      id: "ops-extra",
      version: 0,
      ops: [
        { op: "makeFocusable", selector: "#chip" },
        { op: "bindEnterToClick", selector: "#chip" },
        {
          op: "insertHTML",
          selector: "#host",
          position: "append",
          html: '<a href="#main">Skip</a>',
          mountId: "skip-main",
        },
      ],
    };
    expect(applyPatchSpec(spec).ok).toBe(true);
    expect(applyPatchSpec(spec).ok).toBe(true);
    const chip = document.getElementById("chip");
    expect(chip?.getAttribute("tabindex")).toBe("0");
    expect(chip?.getAttribute("data-lift-enter")).toBe("1");
    expect(document.querySelectorAll('[data-lift-mount="skip-main"]')).toHaveLength(1);
    expect(document.querySelector('[data-lift-mount="skip-main"] a')?.getAttribute("href")).toBe(
      "#main",
    );

    let clicked = 0;
    chip?.addEventListener("click", () => {
      clicked += 1;
    });
    chip?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(clicked).toBe(1);
  });

  it("defaults a mount key so insertHTML without mountId is idempotent", () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const spec = {
      id: "mount-default",
      version: 0,
      ops: [{ op: "insertHTML", selector: "#host", position: "append", html: "<span>Hi</span>" }],
    };
    expect(applyPatchSpec(spec).ok).toBe(true);
    expect(applyPatchSpec(spec).ok).toBe(true);
    expect(document.querySelectorAll("[data-lift-mount]")).toHaveLength(1);
  });

  it("rolls back the whole spec when a required selector misses", () => {
    document.body.innerHTML = `<p id="keep">old</p>`;
    const result = applyPatchSpec({
      id: "skip-missing",
      version: 0,
      ops: [
        { op: "setText", selector: "#keep", text: "new" },
        { op: "setText", selector: "#missing", text: "nope" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("selector did not match");
    expect(document.getElementById("keep")?.textContent).toBe("old");
  });

  it("does not touch the page when the spec is invalid", () => {
    document.body.innerHTML = `<p id="keep">old</p>`;
    const snapshot = document.body.innerHTML;
    const result = applyPatchSpec({
      id: "bad",
      version: 0,
      ops: [{ op: "setAttribute", selector: "#keep", name: "onclick", value: "alert(1)" }],
    });
    expect(result.ok).toBe(false);
    expect(document.body.innerHTML).toBe(snapshot);
  });

  it("rolls back earlier ops when a later op throws", () => {
    document.body.innerHTML = `<p id="keep">old</p>`;
    const original = document.createElement.bind(document);
    document.createElement = ((tag: string) => {
      if (tag === "style") throw new Error("style boom");
      return original(tag);
    }) as typeof document.createElement;
    try {
      const result = applyPatchSpec({
        id: "undo",
        version: 0,
        ops: [
          { op: "setText", selector: "#keep", text: "new" },
          { op: "injectCSS", css: "p { color: red; }" },
        ],
      });
      expect(result.ok).toBe(false);
      expect(document.getElementById("keep")?.textContent).toBe("old");
      expect(document.querySelector("[data-lift-css]")).toBeNull();
    } finally {
      document.createElement = original;
    }
  });

  it("never throws to the caller", () => {
    expect(() => applyPatchSpec(undefined)).not.toThrow();
    expect(applyPatchSpec(undefined).ok).toBe(false);
  });
});
