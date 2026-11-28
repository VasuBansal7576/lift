/** @vitest-environment happy-dom */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
import { ROOT } from "../../agent/src/config.ts";
import { applyPatchSpec, resetRuntimeGuards, validatePatchSpec } from "../../runtime/runtime.js";

const CHECKOUT_HTML = `
  <header>
    <div class="hover-nav">
      <span class="hover-trigger" id="shop-trigger" style="cursor:pointer">Shop</span>
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
    <p class="terms contrast-fail">
      <span class="visible-hint" id="terms-copy">I agree to the terms of sale and understand this order is final.</span>
      <input id="terms" type="checkbox">
    </p>
    <div id="place-order" class="div-pay" data-barrier="div_button" style="color: red; cursor: pointer">💳</div>
  </form>
`;

function checkoutSpec(): unknown {
  return JSON.parse(readFileSync(resolve(ROOT, "runtime/checkout-treatment.json"), "utf8"));
}

afterEach(() => {
  resetRuntimeGuards();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.body.className = "";
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
    expect(shop?.tagName).toBe("SPAN");
    expect(shop?.getAttribute("role")).toBe("button");
    expect(shop?.getAttribute("aria-expanded")).toBe("false");
    expect(shop?.textContent).toBe("Shop");

    const cart = document.getElementById("cart-icon");
    expect(cart?.getAttribute("aria-label")).toBe("View cart and check out");

    expect(document.querySelector('label[for="email"]')?.textContent).toBe("Email");
    expect(document.getElementById("email")?.getAttribute("data-labelled")).toBe("1");
    expect(document.getElementById("email-hint")?.tagName).toBe("LABEL");

    expect(document.getElementById("terms-copy")?.tagName).toBe("LABEL");
    expect(document.querySelector('label[for="terms"]')?.textContent).toContain("I agree to the terms");

    const pay = document.getElementById("place-order");
    expect(pay?.tagName).toBe("DIV");
    expect(pay?.getAttribute("role")).toBe("button");
    expect(pay?.textContent).toBe("Place order");
    expect(pay?.classList.contains("div-pay")).toBe(true);

    expect(document.querySelectorAll("[data-lift-css]")).toHaveLength(1);
  });

  it("promoteToControl keeps the original node and fires its click handler", async () => {
    document.body.innerHTML = `<div id="place-order" class="div-pay" data-barrier="div_button" style="color: red; cursor: pointer">💳<span id="kid">x</span></div>`;
    const original = document.getElementById("place-order");
    let clicks = 0;
    original?.addEventListener("click", () => {
      clicks += 1;
    });
    const result = applyPatchSpec({
      id: "promote",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#place-order", as: "button" }],
    });
    expect(result.ok).toBe(true);
    const next = document.getElementById("place-order");
    expect(next).toBe(original);
    expect(next?.tagName).toBe("DIV");
    expect(next?.getAttribute("role")).toBe("button");
    expect(next?.getAttribute("data-barrier")).toBe("div_button");
    expect(document.getElementById("kid")?.parentElement).toBe(next);
    next?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicks).toBe(1);
    next?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait(0);
    expect(clicks).toBe(2);
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

    document.body.innerHTML = `<p class="terms"><span class="visible-hint" id="terms-copy">I agree</span><input id="terms" type="checkbox"></p>`;
    expect(
      applyPatchSpec({
        id: "wrap-terms",
        version: 0,
        ops: [{ op: "wrapLabel", selector: "#terms", text: "I agree" }],
      }).ok,
    ).toBe(true);
    expect(document.getElementById("terms-copy")?.tagName).toBe("LABEL");
    expect(document.getElementById("terms-copy")?.getAttribute("for")).toBe("terms");

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
          {
            op: "injectCSS",
            rules: [
              {
                selector: { classes: ["x"] },
                declarations: [{ property: "color", value: "#111" }],
              },
            ],
          },
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

  it("makeFocusable, bindEnterToClick, and insertHTML at a mount node", async () => {
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
          html: "<span>Skip</span>",
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
    expect(document.querySelector('[data-lift-mount="skip-main"] span')?.textContent).toBe("Skip");

    let clicked = 0;
    chip?.addEventListener("click", () => {
      clicked += 1;
    });
    chip?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait(0);
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
          {
            op: "injectCSS",
            rules: [
              {
                selector: { classes: ["x"] },
                declarations: [{ property: "color", value: "#111" }],
              },
            ],
          },
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

  it("refuses setText into a style host and leaves CSS untouched", () => {
    document.head.innerHTML = `<style id="s1">.x { color: #111; }</style>`;
    const before = document.getElementById("s1")?.textContent;
    const parsed = validatePatchSpec({
      id: "style-text",
      version: 0,
      ops: [{ op: "setText", selector: "#s1", text: "\\75 rl(http://evil.example)" }],
    });
    expect(parsed.ok).toBe(true);
    const result = applyPatchSpec({
      id: "style-text",
      version: 0,
      ops: [{ op: "setText", selector: "#s1", text: "\\75 rl(http://evil.example)" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("target is not allowlisted");
    expect(document.getElementById("s1")?.textContent).toBe(before);
  });

  it("refuses setText when the target has element children", () => {
    document.body.innerHTML = `<main id="keep"><form id="f"><input id="in"></form></main>`;
    const snapshot = document.body.innerHTML;
    const result = applyPatchSpec({
      id: "settext-main",
      version: 0,
      ops: [{ op: "setText", selector: "#keep", text: "wiped" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("target is not allowlisted");
    expect(document.body.innerHTML).toBe(snapshot);
    expect(document.getElementById("in")).not.toBeNull();
  });

  it("restores leaf text when setText is rolled back", () => {
    document.body.innerHTML = `<p id="keep">old</p>`;
    const result = applyPatchSpec({
      id: "settext-undo",
      version: 0,
      ops: [
        { op: "setText", selector: "#keep", text: "new" },
        { op: "setText", selector: "#missing", text: "nope" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(document.getElementById("keep")?.textContent).toBe("old");
  });

  it("promoteToControl is idempotent and keeps the original click handler", () => {
    document.body.innerHTML = `<div id="x" class="pay" style="cursor:pointer">Pay</div>`;
    let clicks = 0;
    document.getElementById("x")?.addEventListener("click", () => {
      clicks += 1;
    });
    expect(
      applyPatchSpec({
        id: "chain-1",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#x", as: "button" }],
      }).ok,
    ).toBe(true);
    expect(
      applyPatchSpec({
        id: "chain-1",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#x", as: "button" }],
      }).ok,
    ).toBe(true);
    document.getElementById("x")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicks).toBe(1);
    expect(document.getElementById("x")?.tagName).toBe("DIV");
    expect(document.getElementById("x")?.getAttribute("role")).toBe("button");
  });

  it("is idempotent for promoteToControl on a class selector", () => {
    document.body.innerHTML = `<span class="chip" style="cursor:pointer">Go</span>`;
    const spec = {
      id: "class-promote",
      version: 0,
      ops: [{ op: "promoteToControl", selector: ".chip", as: "button" }],
    };
    expect(applyPatchSpec(spec).ok).toBe(true);
    expect(applyPatchSpec(spec).ok).toBe(true);
    expect(document.querySelectorAll("span.chip")).toHaveLength(1);
    expect(document.querySelector("span.chip")?.getAttribute("role")).toBe("button");
  });

  it("updates injectCSS text when the same id carries different css", () => {
    document.body.innerHTML = `<span class="a">a</span>`;
    const first = applyPatchSpec({
      id: "css-1",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          id: "s1",
          rules: [
            { selector: { classes: ["a"] }, declarations: [{ property: "color", value: "#111" }] },
          ],
        },
      ],
    });
    expect(first.ok).toBe(true);
    expect(document.getElementById("lift-patch-css-s1")?.textContent).toContain("#111");
    const second = applyPatchSpec({
      id: "css-2",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          id: "s1",
          rules: [
            { selector: { classes: ["a"] }, declarations: [{ property: "color", value: "#222" }] },
          ],
        },
      ],
    });
    expect(second.ok).toBe(true);
    expect(document.getElementById("lift-patch-css-s1")?.textContent).toContain("#222");
    expect(document.querySelectorAll("[data-lift-css]")).toHaveLength(1);
  });

  it("refuses replaceTag on body and setText on head", () => {
    const snapshot = document.documentElement.outerHTML;
    expect(
      applyPatchSpec({
        id: "kill-body",
        version: 0,
        ops: [{ op: "replaceTag", selector: "body", tag: "span" }],
      }).ok,
    ).toBe(false);
    expect(
      applyPatchSpec({
        id: "kill-head",
        version: 0,
        ops: [{ op: "setText", selector: "head", text: "gone" }],
      }).ok,
    ).toBe(false);
    expect(document.documentElement.outerHTML).toBe(snapshot);
  });

  it("refuses replaceTag when the target contains a form control", () => {
    document.body.innerHTML = `<div id="wrap"><input id="in"></div>`;
    expect(
      applyPatchSpec({
        id: "wrap-input",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#wrap", as: "button" }],
      }).ok,
    ).toBe(false);
    expect(document.getElementById("wrap")?.tagName).toBe("DIV");
    expect(document.getElementById("in")).not.toBeNull();
  });

  it("rejects replaceTag in favor of promoteToControl", () => {
    const parsed = validatePatchSpec({
      id: "a-no-href",
      version: 0,
      ops: [{ op: "replaceTag", selector: "#x", tag: "a" }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("promoteToControl");
  });

  it("does not forward keydown when bindEnterToClick is on the replacement", async () => {
    document.body.innerHTML = `<div id="pay" style="cursor:pointer">Pay</div>`;
    let clicks = 0;
    let keys = 0;
    document.getElementById("pay")?.addEventListener("click", () => {
      clicks += 1;
    });
    document.getElementById("pay")?.addEventListener("keydown", () => {
      keys += 1;
    });
    expect(
      applyPatchSpec({
        id: "enter-once",
        version: 0,
        ops: [
          { op: "promoteToControl", selector: "#pay", as: "button" },
        ],
      }).ok,
    ).toBe(true);
    const next = document.getElementById("pay");
    next?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait(0);
    expect(clicks).toBe(1);
    expect(keys).toBe(1);
  });

  it("refuses insertHTML buttons and reserves data-lift-*", () => {
    document.body.innerHTML = `<div id="host"></div>`;
    expect(
      applyPatchSpec({
        id: "btn",
        version: 0,
        ops: [
          {
            op: "insertHTML",
            selector: "#host",
            position: "append",
            html: "<button>Go</button>",
            mountId: "go-btn",
          },
        ],
      }).ok,
    ).toBe(false);
    expect(
      validatePatchSpec({
        id: "reserved",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#host", name: "data-lift-x", value: "1" }],
      }).ok,
    ).toBe(false);
  });

  it("refuses setText into an SVG style element", () => {
    document.body.innerHTML = `<svg id="g"><style id="svg-style">.x{fill:red}</style></svg>`;
    const before = document.getElementById("svg-style")?.textContent;
    const result = applyPatchSpec({
      id: "svg-style-text",
      version: 0,
      ops: [{ op: "setText", selector: "#svg-style", text: "url(http://evil.example)" }],
    });
    expect(result.ok).toBe(false);
    expect(document.getElementById("svg-style")?.textContent).toBe(before);
  });

  it("restores the previous injectCSS text when a later op rolls back", () => {
    document.body.innerHTML = `<span class="a">a</span>`;
    expect(
      applyPatchSpec({
        id: "css-1",
        version: 0,
        ops: [
          {
            op: "injectCSS",
            id: "s1",
            rules: [
              { selector: { classes: ["a"] }, declarations: [{ property: "color", value: "#111" }] },
            ],
          },
        ],
      }).ok,
    ).toBe(true);
    const rolled = applyPatchSpec({
      id: "css-2",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          id: "s1",
          rules: [
            { selector: { classes: ["a"] }, declarations: [{ property: "color", value: "#222" }] },
          ],
        },
        { op: "setText", selector: "#missing", text: "nope" },
      ],
    });
    expect(rolled.ok).toBe(false);
    expect(document.getElementById("lift-patch-css-s1")?.textContent).toContain("#111");
  });

  it("bindEnterToClick acts only when event.target is the bound element", async () => {
    document.body.innerHTML = `<div id="host">Pay<span id="kid">x</span></div>`;
    let clicks = 0;
    document.getElementById("host")?.addEventListener("click", () => {
      clicks += 1;
    });
    expect(
      applyPatchSpec({
        id: "enter-target",
        version: 0,
        ops: [{ op: "bindEnterToClick", selector: "#host" }],
      }).ok,
    ).toBe(true);
    document.getElementById("kid")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(clicks).toBe(0);
    document.getElementById("host")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait(0);
    expect(clicks).toBe(1);
  });

  it("refuses bindEnterToClick on hosts with interactive descendants", () => {
    document.body.innerHTML = `<div id="host"><button type="button" id="inner">Go</button></div>`;
    const result = applyPatchSpec({
      id: "enter-nested",
      version: 0,
      ops: [{ op: "bindEnterToClick", selector: "#host" }],
    });
    expect(result.ok).toBe(false);
  });

  it("refuses setAttribute aria-hidden on an interactive host", () => {
    document.body.innerHTML = `<button type="button" id="go">Go</button>`;
    const result = applyPatchSpec({
      id: "hide",
      version: 0,
      ops: [{ op: "setAttribute", selector: "#go", name: "aria-hidden", value: "true" }],
    });
    expect(result.ok).toBe(false);
    expect(document.getElementById("go")?.getAttribute("aria-hidden")).toBeNull();
  });

  it("refuses makeFocusable and setAttribute on a form host matched by id", () => {
    document.body.innerHTML = `<form id="f"><span id="x">x</span></form>`;
    expect(
      applyPatchSpec({
        id: "form-focus",
        version: 0,
        ops: [{ op: "makeFocusable", selector: "#f" }],
      }).ok,
    ).toBe(false);
    expect(
      applyPatchSpec({
        id: "form-attr",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#f", name: "aria-label", value: "x" }],
      }).ok,
    ).toBe(false);
    expect(document.getElementById("f")?.hasAttribute("tabindex")).toBe(false);
    expect(document.getElementById("f")?.hasAttribute("aria-label")).toBe(false);
  });

  it("trims hide attributes and tokenizes role at parse time", () => {
    document.body.innerHTML = `<span id="x">x</span>`;
    for (const value of [" true", "true ", "TRUE"]) {
      expect(
        applyPatchSpec({
          id: "pad-hidden",
          version: 0,
          ops: [{ op: "setAttribute", selector: "#x", name: "aria-hidden", value }],
        }).ok,
      ).toBe(false);
    }
    for (const value of ["-01", " -1", "-1x", "-0001"]) {
      expect(
        applyPatchSpec({
          id: "pad-tab",
          version: 0,
          ops: [{ op: "setAttribute", selector: "#x", name: "tabindex", value }],
        }).ok,
      ).toBe(false);
    }
    expect(
      applyPatchSpec({
        id: "role-pres",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#x", name: "role", value: "presentation foo" }],
      }).ok,
    ).toBe(false);
    expect(document.getElementById("x")?.hasAttribute("aria-hidden")).toBe(false);
    expect(document.getElementById("x")?.hasAttribute("tabindex")).toBe(false);
    expect(document.getElementById("x")?.hasAttribute("role")).toBe(false);
  });

  it("refuses tabindex -1 on interactive hosts and aria-hidden true on them", () => {
    document.body.innerHTML = `<button type="button" id="go">Go</button><div id="plain">x</div>`;
    expect(
      applyPatchSpec({
        id: "tab-int",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#go", name: "tabindex", value: "-1" }],
      }).ok,
    ).toBe(false);
    expect(
      applyPatchSpec({
        id: "tab-plain",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#plain", name: "tabindex", value: "-1" }],
      }).ok,
    ).toBe(true);
    expect(document.getElementById("plain")?.getAttribute("tabindex")).toBe("-1");
  });

  it("forbids class via setAttribute", () => {
    document.body.innerHTML = `<span id="x" class="keep">x</span>`;
    expect(
      applyPatchSpec({
        id: "class-add",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#x", name: "class", value: "extra" }],
      }).ok,
    ).toBe(false);
    expect(document.getElementById("x")?.className).toBe("keep");
  });

  it("refuses replaceTag when the host has an interactive descendant", () => {
    document.body.innerHTML = `<div id="wrap"><a href="#x">go</a></div>`;
    expect(
      applyPatchSpec({
        id: "rt-a",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#wrap", as: "button" }],
      }).ok,
    ).toBe(false);
    document.body.innerHTML = `<div id="wrap"><span contenteditable="true">x</span></div>`;
    expect(
      applyPatchSpec({
        id: "rt-ce",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#wrap", as: "button" }],
      }).ok,
    ).toBe(false);
  });

  it("refuses replaceTag to label", () => {
    document.body.innerHTML = `<span id="lab">L</span><input id="email" type="email">`;
    expect(
      applyPatchSpec({
        id: "for-label",
        version: 0,
        ops: [{ op: "replaceTag", selector: "#lab", tag: "label", attributes: { for: "email" } }],
      }).ok,
    ).toBe(false);
  });

  it("refuses wrapLabel on a submit input", () => {
    document.body.innerHTML = `<input id="go" type="submit">`;
    expect(
      applyPatchSpec({
        id: "wrap-submit",
        version: 0,
        ops: [{ op: "wrapLabel", selector: "#go", text: "Go" }],
      }).ok,
    ).toBe(false);
  });

  it("refuses insertHTML into body/html/input at apply time", () => {
    document.body.innerHTML = `<input id="email" type="email"><div id="host"></div><main id="main"></main>`;
    expect(
      applyPatchSpec({
        id: "ins-input",
        version: 0,
        ops: [{ op: "insertHTML", selector: "#email", position: "after", html: "<span>x</span>" }],
      }).ok,
    ).toBe(false);
    expect(
      applyPatchSpec({
        id: "ins-main",
        version: 0,
        ops: [{ op: "insertHTML", selector: "#host", position: "prepend", html: "<span>Skip</span>" }],
      }).ok,
    ).toBe(true);
  });

  it("undoes injectCSS when a class anchor matches body or a page container", () => {
    document.body.className = "lift-atk";
    document.body.innerHTML = `<p class="keep">x</p>`;
    const before = document.body.innerHTML;
    const result = applyPatchSpec({
      id: "css-body",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["lift-atk"] },
              declarations: [{ property: "color", value: "#111" }],
            },
          ],
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(document.querySelector("[data-lift-css]")).toBeNull();
    expect(document.body.innerHTML).toBe(before);
    document.body.className = "";
  });

  it("undoes injectCSS when computed contrast falls below 4.5:1", () => {
    document.body.innerHTML = `<p class="ghost" style="background-color:#fff">x</p>`;
    const result = applyPatchSpec({
      id: "css-contrast",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["ghost"] },
              declarations: [{ property: "color", value: "#fff" }],
            },
          ],
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(document.querySelector("[data-lift-css]")).toBeNull();
  });

  it("toggles a disclosure panel from the trigger and undoes", () => {
    document.body.innerHTML = `
      <button type="button" id="shop-trigger">Shop</button>
      <div id="shop-menu">menu</div>
    `;
    const rolled = applyPatchSpec({
      id: "disc-undo",
      version: 0,
      ops: [
        { op: "toggleDisclosure", trigger: "#shop-trigger", panel: "#shop-menu" },
        { op: "setText", selector: "#missing", text: "x" },
      ],
    });
    expect(rolled.ok).toBe(false);
    expect(document.getElementById("shop-trigger")?.getAttribute("data-lift-disclosure")).toBeNull();
    expect(document.getElementById("shop-menu")?.classList.contains("lift-open")).toBe(false);

    expect(
      applyPatchSpec({
        id: "disc",
        version: 0,
        ops: [{ op: "toggleDisclosure", trigger: "#shop-trigger", panel: "#shop-menu" }],
      }).ok,
    ).toBe(true);
    const trigger = document.getElementById("shop-trigger");
    const panel = document.getElementById("shop-menu");
    trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel?.classList.contains("lift-open")).toBe(true);
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
  });

  it("undoes injectCSS when a rule matches more than 50 elements", () => {
    document.body.innerHTML = Array.from({ length: 51 }, (_, i) => `<span class="many">${i}</span>`).join("");
    const result = applyPatchSpec({
      id: "css-many",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["many"] },
              declarations: [{ property: "color", value: "#111" }],
            },
          ],
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(document.querySelector("[data-lift-css]")).toBeNull();
  });

  it("checkout treatment opens shop via toggleDisclosure", () => {
    document.body.innerHTML = CHECKOUT_HTML;
    expect(applyPatchSpec(checkoutSpec()).ok).toBe(true);
    const shop = document.getElementById("shop-trigger");
    shop?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.getElementById("shop-menu")?.classList.contains("lift-open")).toBe(true);
  });
});

