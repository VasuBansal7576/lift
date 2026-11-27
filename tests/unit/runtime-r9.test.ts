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

function colorSpec(id: string, selector: object) {
  return {
    id,
    version: 0,
    ops: [
      css([
        {
          selector,
          declarations: [
            { property: "color", value: "#111" },
            { property: "background-color", value: "#fff" },
          ],
        },
      ]),
    ],
  };
}

function key(el: Element | null, type: string, keyName: string, extra: KeyboardEventInit = {}) {
  el?.dispatchEvent(
    new KeyboardEvent(type, { key: keyName, bubbles: true, cancelable: true, ...extra }),
  );
}

describe("R9 W1 activation bridge", () => {
  it("skips the bridge when the host preventDefault()s and clicks on Enter", () => {
    document.body.innerHTML = `<div id="h" style="cursor:pointer">Pay</div>`;
    const host = document.getElementById("h");
    const log: string[] = [];
    host?.addEventListener("keydown", (event) => {
      log.push("ownkey");
      event.preventDefault();
      host.click();
    });
    host?.addEventListener("click", () => {
      log.push("click");
    });
    expect(
      applyPatchSpec({
        id: "no-double",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#h", as: "button" }],
      }).ok,
    ).toBe(true);
    key(host, "keydown", "Enter");
    expect(log).toEqual(["ownkey", "click"]);
  });

  it("activates Space once on keyup and ignores keydown repeats", () => {
    document.body.innerHTML = `<div id="h" style="cursor:pointer">Pay</div>`;
    const host = document.getElementById("h");
    let clicks = 0;
    host?.addEventListener("click", () => {
      clicks += 1;
    });
    expect(
      applyPatchSpec({
        id: "space-once",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#h", as: "button" }],
      }).ok,
    ).toBe(true);
    key(host, "keydown", " ");
    key(host, "keydown", " ", { repeat: true });
    key(host, "keydown", " ", { repeat: true });
    key(host, "keydown", " ", { repeat: true });
    expect(clicks).toBe(0);
    key(host, "keyup", " ");
    expect(clicks).toBe(1);
  });

  it("ignores Enter keydown repeats", () => {
    document.body.innerHTML = `<div id="h" style="cursor:pointer">Pay</div>`;
    const host = document.getElementById("h");
    let clicks = 0;
    host?.addEventListener("click", () => {
      clicks += 1;
    });
    expect(
      applyPatchSpec({
        id: "enter-repeat",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#h", as: "button" }],
      }).ok,
    ).toBe(true);
    key(host, "keydown", "Enter");
    key(host, "keydown", "Enter", { repeat: true });
    key(host, "keydown", "Enter", { repeat: true });
    key(host, "keydown", "Enter", { repeat: true });
    expect(clicks).toBe(1);
  });

  it("bindEnterToClick does not double-fire when the host already clicks on Enter", () => {
    document.body.innerHTML = `<div id="h">Pay</div>`;
    const host = document.getElementById("h");
    let clicks = 0;
    host?.addEventListener("keydown", (event) => {
      event.preventDefault();
      host.click();
    });
    host?.addEventListener("click", () => {
      clicks += 1;
    });
    expect(
      applyPatchSpec({
        id: "bind-no-double",
        version: 0,
        ops: [{ op: "bindEnterToClick", selector: "#h" }],
      }).ok,
    ).toBe(true);
    key(host, "keydown", "Enter");
    expect(clicks).toBe(1);
  });
});

describe("R9 W2 promoteToControl gates", () => {
  it("parse-rejects the self-attested hasClickAffordance flag", () => {
    const parsed = parsePatchSpec({
      id: "attested",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#h", as: "button", hasClickAffordance: true }],
    });
    expect(parsed.ok).toBe(false);
  });

  it("accepts cursor:pointer, onclick, or a click listener, and rejects a bare host", () => {
    document.body.innerHTML = `
      <div id="cursor" style="cursor:pointer">Go</div>
      <div id="onclick" onclick="void 0">Go</div>
      <div id="listen">Go</div>
      <div id="bare">Go</div>
    `;
    document.getElementById("listen")?.addEventListener("click", () => {});
    expect(
      applyPatchSpec({
        id: "c",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#cursor", as: "button" }],
      }).ok,
    ).toBe(true);
    expect(
      applyPatchSpec({
        id: "o",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#onclick", as: "button" }],
      }).ok,
    ).toBe(true);
    expect(
      applyPatchSpec({
        id: "l",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#listen", as: "button" }],
      }).ok,
    ).toBe(true);
    expect(
      applyPatchSpec({
        id: "b",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#bare", as: "button" }],
      }).ok,
    ).toBe(false);
  });

  it("rejects aria-hidden, inert, contenteditable, and empty accessible name", () => {
    document.body.innerHTML = `
      <div aria-hidden="true"><div id="hid" style="cursor:pointer">Go</div></div>
      <div inert><div id="inert" style="cursor:pointer">Go</div></div>
      <div id="ce" contenteditable="true" style="cursor:pointer">Go</div>
      <div id="empty" style="cursor:pointer"></div>
    `;
    for (const id of ["hid", "inert", "ce", "empty"]) {
      expect(
        applyPatchSpec({
          id: `gate-${id}`,
          version: 0,
          ops: [{ op: "promoteToControl", selector: `#${id}`, as: "button" }],
        }).ok,
        id,
      ).toBe(false);
    }
  });

  it("raises a negative tabindex to 0 and restores it on undo", async () => {
    document.head.insertAdjacentHTML(
      "beforeend",
      `<style>.panel { color: #fff; background-color: #111; }</style>`,
    );
    document.body.innerHTML = `
      <div id="panel" class="panel">Hello</div>
      <div id="h" tabindex="-1" style="cursor:pointer">Go</div>
    `;
    const host = document.getElementById("h");
    expect(
      applyPatchSpec({
        id: "tab",
        version: 0,
        ops: [
          css([
            {
              selector: { classes: ["panel"] },
              declarations: [
                { property: "color", value: "#111" },
                { property: "background-color", value: "#fff" },
              ],
            },
          ]),
          { op: "promoteToControl", selector: "#h", as: "button" },
        ],
      }).ok,
    ).toBe(true);
    expect(host?.tabIndex).toBe(0);
    const ghost = document.createElement("span");
    ghost.style.color = "#fff";
    ghost.textContent = "hid";
    document.getElementById("panel")?.append(ghost);
    await wait(80);
    expect(host?.getAttribute("tabindex")).toBe("-1");
  });
});

describe("R9 W3 page-caused vs spec-caused guard", () => {
  it("keeps the fix when a modal hides a watched control", async () => {
    document.body.innerHTML = `<button type="button" id="keep" class="keep">Keep</button>`;
    expect(applyPatchSpec(colorSpec("modal", { classes: ["keep"] })).ok).toBe(true);
    const keep = document.getElementById("keep");
    if (keep instanceof HTMLElement) keep.hidden = true;
    await wait(80);
    expect(document.querySelector("[data-lift-css]")).not.toBeNull();
  });

  it("keeps the fix when a wizard step hides the host", async () => {
    document.body.innerHTML = `<div class="step"><button type="button" class="next">Next</button></div>`;
    expect(applyPatchSpec(colorSpec("wizard", { classes: ["next"] })).ok).toBe(true);
    const step = document.querySelector(".step");
    if (step instanceof HTMLElement) step.style.display = "none";
    await wait(80);
    expect(document.querySelector("[data-lift-css]")).not.toBeNull();
  });

  it("keeps the fix when an SPA replace removes the original node", async () => {
    document.body.innerHTML = `<button type="button" class="pay" id="pay">Pay</button>`;
    expect(applyPatchSpec(colorSpec("spa", { classes: ["pay"] })).ok).toBe(true);
    const next = document.createElement("button");
    next.id = "pay";
    next.className = "pay";
    next.type = "button";
    next.textContent = "Pay";
    document.getElementById("pay")?.replaceWith(next);
    await wait(80);
    expect(document.querySelector("[data-lift-css]")).not.toBeNull();
  });

  it("keeps the fix when infinite scroll exceeds the match cap", async () => {
    document.body.innerHTML = `<div id="list"></div>`;
    const list = document.getElementById("list");
    for (let i = 0; i < 10; i += 1) {
      const item = document.createElement("span");
      item.className = "item";
      item.textContent = "row";
      list?.append(item);
    }
    expect(applyPatchSpec(colorSpec("scroll", { classes: ["item"] })).ok).toBe(true);
    for (let i = 0; i < 60; i += 1) {
      const item = document.createElement("span");
      item.className = "item";
      item.textContent = "row";
      list?.append(item);
    }
    await wait(80);
    expect(document.querySelector("[data-lift-css]")).not.toBeNull();
  });

  it("still undoes a genuine spec-caused contrast regression", async () => {
    document.head.insertAdjacentHTML(
      "beforeend",
      `<style>.panel { color: #fff; background-color: #111; }</style>`,
    );
    document.body.innerHTML = `<div class="panel">Hello</div>`;
    expect(applyPatchSpec(colorSpec("spec-caused", { classes: ["panel"] })).ok).toBe(true);
    const ghost = document.createElement("span");
    ghost.style.color = "#fff";
    ghost.textContent = "hid";
    document.querySelector(".panel")?.append(ghost);
    await wait(80);
    expect(document.querySelector("[data-lift-css]")).toBeNull();
  });

  it("keeps a color fix when the page sets a thick outline on the host", async () => {
    document.body.innerHTML = `<button type="button" class="keep">Keep</button>`;
    expect(applyPatchSpec(colorSpec("outline-page", { classes: ["keep"] })).ok).toBe(true);
    const keep = document.querySelector(".keep");
    if (keep instanceof HTMLElement) {
      keep.style.outline = "6px solid #f00";
      keep.style.outlineOffset = "4px";
    }
    await wait(80);
    expect(document.querySelector("[data-lift-css]")).not.toBeNull();
  });

  it("still undoes spec-caused contrast when an unrelated overlay covers another control", async () => {
    document.head.insertAdjacentHTML(
      "beforeend",
      `<style>.panel { color: #fff; background-color: #111; }</style>`,
    );
    document.body.innerHTML = `
      <div class="panel">Hello</div>
      <button type="button" id="buy">Buy</button>
    `;
    expect(applyPatchSpec(colorSpec("ghost-plus-banner", { classes: ["panel"] })).ok).toBe(true);
    const banner = document.createElement("div");
    banner.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:#111;color:#fff";
    banner.textContent = "evidence banner";
    document.body.prepend(banner);
    const ghost = document.createElement("span");
    ghost.style.color = "#fff";
    ghost.textContent = "hid";
    document.querySelector(".panel")?.append(ghost);
    await wait(80);
    expect(document.querySelector("[data-lift-css]")).toBeNull();
  });
});

describe("R9 W4 coverage on color-only dropdowns", () => {
  it("keeps a color fix when a submenu opens over a control", async () => {
    document.body.innerHTML = `
      <div class="nav" style="position:relative;background-color:#fff;color:#111">Shop</div>
      <button type="button" id="buy" style="margin-top:8px">Buy</button>
    `;
    expect(applyPatchSpec(colorSpec("nav-color", { classes: ["nav"] })).ok).toBe(true);
    const menu = document.createElement("div");
    menu.className = "submenu";
    menu.textContent = "Checkout";
    menu.style.cssText =
      "position:absolute;top:0;left:0;width:240px;height:120px;background:#111;color:#fff;z-index:9";
    document.querySelector(".nav")?.append(menu);
    await wait(80);
    expect(document.querySelector("[data-lift-css]")).not.toBeNull();
  });
});

describe("R9 I5 elementsFromPointAt", () => {
  it("does not scroll the window when hit-testing an off-screen overlay", () => {
    const calls: unknown[][] = [];
    const view = window as Window & { scrollTo: (...args: unknown[]) => void };
    const orig = view.scrollTo.bind(view);
    view.scrollTo = (...args: unknown[]) => {
      calls.push(args);
    };
    document.body.innerHTML = `
      <button type="button" id="buy" style="position:fixed;top:20000px;left:0">Buy</button>
      <div class="bar" style="position:fixed;top:20000px;left:0;width:400px;height:80px;background:#111">Cookies</div>
    `;
    applyPatchSpec({
      id: "offscreen",
      version: 0,
      ops: [
        css([
          {
            selector: { classes: ["bar"] },
            declarations: [
              { property: "min-height", value: "64px" },
              { property: "padding", value: "24px" },
            ],
          },
        ]),
      ],
    });
    view.scrollTo = orig;
    expect(calls).toEqual([]);
  });
});

describe("R9 I1 sticky hit-target", () => {
  it("still refuses min-height on the sticky header itself", () => {
    document.body.innerHTML = `<header class="mast" style="position:sticky;top:0">Shop</header>`;
    expect(
      applyPatchSpec({
        id: "sticky-header",
        version: 0,
        ops: [
          css([
            {
              selector: { classes: ["mast"] },
              declarations: [{ property: "min-height", value: "64px" }],
            },
          ]),
        ],
      }).ok,
    ).toBe(false);
  });

  it("allows min-height on an inline link inside a sticky header", () => {
    document.body.innerHTML = `
      <header id="mast-ok" style="position:sticky;top:0;height:80px;background-color:#fff">
        <a id="hit" href="#x" style="color:#111;background-color:#fff;display:inline-flex">Go</a>
      </header>
    `;
    const box = (left: number, top: number, width: number, height: number) => ({
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON() {
        return this;
      },
    });
    const mast = document.getElementById("mast-ok") as HTMLElement;
    const hit = document.getElementById("hit") as HTMLElement;
    mast.getBoundingClientRect = () => box(0, 0, 400, 80) as DOMRect;
    hit.getBoundingClientRect = () => box(8, 18, 40, 44) as DOMRect;
    expect(
      applyPatchSpec({
        id: "sticky-hit",
        version: 0,
        ops: [
          css([
            {
              selector: { id: "hit" },
              declarations: [{ property: "min-height", value: "44px" }],
            },
          ]),
        ],
      }).ok,
    ).toBe(true);
  });
});
