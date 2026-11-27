/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it } from "vitest";
import { applyPatchSpec, parsePatchSpec, resetRuntimeGuards } from "../../runtime/runtime.js";

afterEach(() => {
  resetRuntimeGuards();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.body.className = "";
});

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function css(rules: object[]) {
  return { op: "injectCSS" as const, rules };
}

describe("R6 #1 replaceTag interactive hosts", () => {
  it("refuses replacing a button, linked a, input, or interactive role unless the new tag is button or a", () => {
    document.body.innerHTML = `
      <button type="button" id="go">Go</button>
      <a id="link" href="#x">Go</a>
      <input id="in">
      <div id="role" role="button">Go</div>
      <span id="plain">Go</span>
    `;
    expect(
      applyPatchSpec({
        id: "rt-btn",
        version: 0,
        ops: [{ op: "replaceTag", selector: "#go", tag: "span" }],
      }).ok,
    ).toBe(false);
    expect(document.getElementById("go")?.tagName).toBe("BUTTON");
    expect(
      applyPatchSpec({
        id: "rt-a",
        version: 0,
        ops: [{ op: "replaceTag", selector: "#link", tag: "span" }],
      }).ok,
    ).toBe(false);
    expect(document.getElementById("link")?.tagName).toBe("A");
    expect(
      applyPatchSpec({
        id: "rt-in",
        version: 0,
        ops: [{ op: "replaceTag", selector: "#in", tag: "span" }],
      }).ok,
    ).toBe(false);
    expect(
      applyPatchSpec({
        id: "rt-role",
        version: 0,
        ops: [{ op: "replaceTag", selector: "#role", tag: "span" }],
      }).ok,
    ).toBe(false);
    expect(document.getElementById("role")?.tagName).toBe("DIV");
    expect(
      applyPatchSpec({
        id: "rt-plain",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#plain", as: "button", hasClickAffordance: true }],
      }).ok,
    ).toBe(true);
    expect(document.getElementById("plain")?.tagName).toBe("SPAN");
    expect(document.getElementById("plain")?.getAttribute("role")).toBe("button");
  });
});

describe("R6 #2 attribute allowlist", () => {
  it("forbids class in setAttribute, replaceTag, and insertHTML", () => {
    document.body.innerHTML = `<span id="x" class="keep">x</span><div id="host"></div>`;
    expect(
      applyPatchSpec({
        id: "class-set",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#x", name: "class", value: "gone" }],
      }).ok,
    ).toBe(false);
    expect(parsePatchSpec({
      id: "class-rt",
      version: 0,
      ops: [{ op: "replaceTag", selector: "#x", tag: "span", attributes: { class: "x" } }],
    }).ok).toBe(false);
    expect(parsePatchSpec({
      id: "class-ins",
      version: 0,
      ops: [{ op: "insertHTML", selector: "#host", position: "append", html: '<span class="x">x</span>' }],
    }).ok).toBe(false);
    expect(document.getElementById("x")?.className).toBe("keep");
  });

  it("rejects aria-hidden, aria-expanded via setAttribute, and unresolved labelledby/describedby", () => {
    document.body.innerHTML = `<span id="x">x</span><span id="empty">   </span>`;
    expect(
      parsePatchSpec({
        id: "hid",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#x", name: "aria-hidden", value: "true" }],
      }).ok,
    ).toBe(false);
    expect(
      parsePatchSpec({
        id: "exp",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#x", name: "aria-expanded", value: "true" }],
      }).ok,
    ).toBe(false);
    expect(
      applyPatchSpec({
        id: "by-miss",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#x", name: "aria-labelledby", value: "nope" }],
      }).ok,
    ).toBe(false);
    expect(
      applyPatchSpec({
        id: "by-empty",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#x", name: "aria-describedby", value: "empty" }],
      }).ok,
    ).toBe(false);
    document.body.innerHTML = `<span id="x"></span><span id="nm">Name</span>`;
    expect(
      applyPatchSpec({
        id: "by-ok",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#x", name: "aria-labelledby", value: "nm" }],
      }).ok,
    ).toBe(true);
  });

  it("allows aria-live polite only", () => {
    document.body.innerHTML = `<span id="x">x</span>`;
    expect(
      parsePatchSpec({
        id: "live-bad",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#x", name: "aria-live", value: "assertive" }],
      }).ok,
    ).toBe(false);
    expect(
      applyPatchSpec({
        id: "live-ok",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#x", name: "aria-live", value: "polite" }],
      }).ok,
    ).toBe(true);
  });
});

describe("R6 #3 / S2(e) state rules", () => {
  it("rejects color and background-color on hover/focus/active at parse time", () => {
    for (const state of ["hover", "focus", "focus-visible", "active"]) {
      expect(
        parsePatchSpec({
          id: `st-${state}`,
          version: 0,
          ops: [
            css([
              {
                selector: { classes: ["x"], state },
                declarations: [{ property: "color", value: "#111" }],
              },
            ]),
          ],
        }).ok,
        state,
      ).toBe(false);
    }
  });

  it("allows outline on hover and refuses outline-color below 3:1 against the background", () => {
    document.body.innerHTML = `<span class="chip" style="background-color:#fff">x</span>`;
    expect(
      applyPatchSpec({
        id: "outline-ok",
        version: 0,
        ops: [
          css([
            {
              selector: { classes: ["chip"], state: "hover" },
              declarations: [
                { property: "outline-style", value: "solid" },
                { property: "outline-color", value: "#000" },
                { property: "outline-width", value: "2px" },
              ],
            },
          ]),
        ],
      }).ok,
    ).toBe(true);
    resetRuntimeGuards();
    document.head.innerHTML = "";
    expect(
      applyPatchSpec({
        id: "outline-bad",
        version: 0,
        ops: [
          css([
            {
              selector: { classes: ["chip"], state: "hover" },
              declarations: [
                { property: "outline-style", value: "solid" },
                { property: "outline-color", value: "#fff" },
                { property: "outline-width", value: "2px" },
              ],
            },
          ]),
        ],
      }).ok,
    ).toBe(false);
    expect(document.querySelector("[data-lift-css]")).toBeNull();
  });
});

describe("R6 #4 / S2(a) descendant contrast", () => {
  it("undoes when a matched parent is fine but a text-bearing descendant fails 4.5:1", () => {
    document.body.innerHTML = `<div class="card">ok<span class="ghost" style="color:#fff">hid</span></div>`;
    const result = applyPatchSpec({
      id: "desc-contrast",
      version: 0,
      ops: [
        css([
          {
            selector: { classes: ["card"] },
            declarations: [{ property: "background-color", value: "#fff" }],
          },
        ]),
      ],
    });
    expect(result.ok).toBe(false);
    expect(document.querySelector("[data-lift-css]")).toBeNull();
  });

  it("refuses when descendant count exceeds 500", () => {
    const kids = Array.from({ length: 501 }, (_, i) => `<span>${i}</span>`).join("");
    document.body.innerHTML = `<div class="card">${kids}</div>`;
    expect(
      applyPatchSpec({
        id: "cap",
        version: 0,
        ops: [
          css([
            {
              selector: { classes: ["card"] },
              declarations: [{ property: "color", value: "#111" }],
            },
          ]),
        ],
      }).ok,
    ).toBe(false);
  });
});

describe("R6 #5 / S2(c,d) zero matches and MutationObserver", () => {
  it("refuses a CSS rule with zero matches at apply time", () => {
    document.body.innerHTML = `<span class="other">x</span>`;
    expect(
      applyPatchSpec({
        id: "zero",
        version: 0,
        ops: [
          css([
            {
              selector: { classes: ["missing"] },
              declarations: [{ property: "color", value: "#111" }],
            },
          ]),
        ],
      }).ok,
    ).toBe(false);
    expect(document.querySelector("[data-lift-css]")).toBeNull();
  });

  it("undoes the spec and records fail-open when late content breaks contrast", async () => {
    document.body.innerHTML = `<div class="slot">ok</div>`;
    expect(
      applyPatchSpec({
        id: "late",
        version: 0,
        ops: [
          css([
            {
              selector: { classes: ["slot"] },
              declarations: [
                { property: "color", value: "#111" },
                { property: "background-color", value: "#fff" },
              ],
            },
          ]),
        ],
      }).ok,
    ).toBe(true);
    expect(document.querySelector("[data-lift-css]")).not.toBeNull();
    document.querySelector(".slot")?.insertAdjacentHTML(
      "beforeend",
      `<span style="color:#fff">hid</span>`,
    );
    await wait(80);
    expect(document.querySelector("[data-lift-css]")).toBeNull();
    expect((window as unknown as { __LIFT_FAIL_OPEN__: { reason: string }[] }).__LIFT_FAIL_OPEN__.length).toBeGreaterThan(
      0,
    );
  });
});

describe("R6 #6 setText", () => {
  it("requires non-empty trimmed text and refuses interactive hosts", () => {
    document.body.innerHTML = `<span id="t">old</span><button type="button" id="go">Go</button>`;
    expect(
      parsePatchSpec({
        id: "empty",
        version: 0,
        ops: [{ op: "setText", selector: "#t", text: "   " }],
      }).ok,
    ).toBe(false);
    expect(
      applyPatchSpec({
        id: "btn-text",
        version: 0,
        ops: [{ op: "setText", selector: "#go", text: "Nope" }],
      }).ok,
    ).toBe(false);
    expect(document.getElementById("go")?.textContent).toBe("Go");
    expect(
      applyPatchSpec({
        id: "span-text",
        version: 0,
        ops: [{ op: "setText", selector: "#t", text: "new" }],
      }).ok,
    ).toBe(true);
    expect(document.getElementById("t")?.textContent).toBe("new");
  });
});

describe("R6 #7 border-width", () => {
  it("rejects border-width below 1px", () => {
    expect(
      parsePatchSpec({
        id: "bw",
        version: 0,
        ops: [
          css([
            {
              selector: { classes: ["x"] },
              declarations: [{ property: "border-width", value: "0px" }],
            },
          ]),
        ],
      }).ok,
    ).toBe(false);
  });
});

describe("R6 #8 roles", () => {
  it("restricts interactive hosts to matching INTERACTIVE_ROLES and allows landmark roles on non-interactive hosts", () => {
    document.body.innerHTML = `<button type="button" id="go">Go</button><span id="x">x</span>`;
    expect(
      applyPatchSpec({
        id: "role-link",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#go", name: "role", value: "link" }],
      }).ok,
    ).toBe(false);
    expect(
      applyPatchSpec({
        id: "role-btn",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#go", name: "role", value: "button" }],
      }).ok,
    ).toBe(true);
    expect(
      applyPatchSpec({
        id: "role-region",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#x", name: "role", value: "region" }],
      }).ok,
    ).toBe(true);
    expect(
      parsePatchSpec({
        id: "role-pres",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#x", name: "role", value: "presentation" }],
      }).ok,
    ).toBe(false);
  });
});

describe("R6 #9 replaceTag to button forces type=button", () => {
  it("sets type=button and rejects type in attributes", () => {
    document.body.innerHTML = `<div id="pay">Pay</div>`;
    expect(
      parsePatchSpec({
        id: "type-attr",
        version: 0,
        ops: [{ op: "replaceTag", selector: "#pay", tag: "button", attributes: { type: "submit" } }],
      }).ok,
    ).toBe(false);
    expect(
      applyPatchSpec({
        id: "to-btn",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#pay", as: "button", hasClickAffordance: true }],
      }).ok,
    ).toBe(true);
    expect(document.getElementById("pay")?.getAttribute("role")).toBe("button");
    expect(document.getElementById("pay")?.tagName).toBe("DIV");
  });
});

describe("R6 #10 insertHTML", () => {
  it("refuses interactive ancestors, interactive markup, and hide attributes on inserted nodes", () => {
    document.body.innerHTML = `
      <button type="button" id="go"><span id="inner">x</span></button>
      <div id="host"></div>
    `;
    expect(
      applyPatchSpec({
        id: "ins-btn",
        version: 0,
        ops: [{ op: "insertHTML", selector: "#go", position: "append", html: "<span>x</span>" }],
      }).ok,
    ).toBe(false);
    expect(
      applyPatchSpec({
        id: "ins-anc",
        version: 0,
        ops: [{ op: "insertHTML", selector: "#inner", position: "append", html: "<span>x</span>" }],
      }).ok,
    ).toBe(false);
    expect(
      parsePatchSpec({
        id: "ins-a",
        version: 0,
        ops: [{ op: "insertHTML", selector: "#host", position: "append", html: '<a href="#x">x</a>' }],
      }).ok,
    ).toBe(false);
    expect(
      applyPatchSpec({
        id: "ins-ok",
        version: 0,
        ops: [{ op: "insertHTML", selector: "#host", position: "append", html: "<span>note</span>" }],
      }).ok,
    ).toBe(true);
  });
});

describe("R6 #11 toggleDisclosure contains()", () => {
  it("toggles when the click is inside the trigger, including on a child", () => {
    document.body.innerHTML = `
      <button type="button" id="shop-trigger"><span id="label">Shop</span></button>
      <div id="shop-menu">menu</div>
    `;
    expect(
      applyPatchSpec({
        id: "disc",
        version: 0,
        ops: [{ op: "toggleDisclosure", trigger: "#shop-trigger", panel: "#shop-menu" }],
      }).ok,
    ).toBe(true);
    document.getElementById("label")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.getElementById("shop-menu")?.classList.contains("lift-open")).toBe(true);
    document.getElementById("shop-menu")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.getElementById("shop-menu")?.classList.contains("lift-open")).toBe(true);
  });
});

describe("R6 #12 / S2(b) unknown background", () => {
  it("refuses color changes when an ancestor has background-image, translucent rgba, or opacity < 1", () => {
    document.body.innerHTML = `
      <div class="hero" style="background-image:url(x.png)"><span class="t">x</span></div>
    `;
    expect(
      applyPatchSpec({
        id: "img",
        version: 0,
        ops: [
          css([
            {
              selector: { classes: ["t"] },
              declarations: [{ property: "color", value: "#111" }],
            },
          ]),
        ],
      }).ok,
    ).toBe(false);
    document.body.innerHTML = `<div class="hero" style="background-color:rgba(0,0,0,0.4)"><span class="t">x</span></div>`;
    expect(
      applyPatchSpec({
        id: "rgba",
        version: 0,
        ops: [
          css([
            {
              selector: { classes: ["t"] },
              declarations: [{ property: "color", value: "#111" }],
            },
          ]),
        ],
      }).ok,
    ).toBe(false);
    document.body.innerHTML = `<div class="hero" style="opacity:0.9"><span class="t">x</span></div>`;
    expect(
      applyPatchSpec({
        id: "opac",
        version: 0,
        ops: [
          css([
            {
              selector: { classes: ["t"] },
              declarations: [{ property: "color", value: "#111" }],
            },
          ]),
        ],
      }).ok,
    ).toBe(false);
  });
});

describe("R6 #13 page containers", () => {
  it("refuses role landmarks and hosts that contain more than half of body's descendants", () => {
    document.body.innerHTML = `<div id="host" role="main">x</div>`;
    expect(
      applyPatchSpec({
        id: "role-main",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#host", name: "aria-label", value: "Main" }],
      }).ok,
    ).toBe(false);
    const kids = Array.from({ length: 12 }, (_, i) => `<span>${i}</span>`).join("");
    document.body.innerHTML = `<div id="big">${kids}</div><i>y</i>`;
    expect(
      applyPatchSpec({
        id: "half",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#big", name: "aria-label", value: "nope" }],
      }).ok,
    ).toBe(false);
    expect(document.getElementById("big")?.querySelectorAll("span").length).toBe(12);
  });
});

describe("R6 S1 accessibility monotonicity", () => {
  it("undoes emptying an accessible name via aria-label", () => {
    document.body.innerHTML = `<button type="button" id="go" aria-label="Go"></button>`;
    const result = applyPatchSpec({
      id: "mono-name",
      version: 0,
      ops: [{ op: "setAttribute", selector: "#go", name: "aria-label", value: "" }],
    });
    expect(result.ok).toBe(false);
    expect(document.getElementById("go")?.getAttribute("aria-label")).toBe("Go");
  });

  it("undoes replaceTag from button to span (defence in depth with #1)", () => {
    document.body.innerHTML = `<button type="button" id="go">Go</button>`;
    const result = applyPatchSpec({
      id: "btn-span",
      version: 0,
      ops: [{ op: "replaceTag", selector: "#go", tag: "span" }],
    });
    expect(result.ok).toBe(false);
    expect(document.getElementById("go")?.tagName).toBe("BUTTON");
  });
});

describe("R6 S2(f) border-color contrast", () => {
  it("requires 3:1 for border-color against the effective background", () => {
    document.body.innerHTML = `<span class="chip" style="background-color:#fff">x</span>`;
    expect(
      applyPatchSpec({
        id: "border-bad",
        version: 0,
        ops: [
          css([
            {
              selector: { classes: ["chip"] },
              declarations: [
                { property: "border-style", value: "solid" },
                { property: "border-width", value: "1px" },
                { property: "border-color", value: "#fff" },
              ],
            },
          ]),
        ],
      }).ok,
    ).toBe(false);
  });
});
