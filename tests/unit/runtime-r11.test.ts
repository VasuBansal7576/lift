/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it } from "vitest";
import { applyPatchSpec, getRuntimeStats, resetRuntimeGuards } from "../../runtime/runtime.js";

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

describe("R11 attribution does not loop", () => {
  it("counts 0 undos and at most 1 attribution when the page paints #eee on white", async () => {
    document.body.innerHTML = `<a id="hit" href="#x" style="color:#111;background-color:#fff">Go</a>`;
    const appliedMin = applyPatchSpec({
      id: "minw",
      version: 0,
      ops: [
        css([
          {
            selector: { id: "hit" },
            declarations: [{ property: "min-width", value: "44px" }],
          },
        ]),
      ],
    });
    expect(appliedMin.ok, JSON.stringify(appliedMin)).toBe(true);
    const before = getRuntimeStats();
    const hit = document.getElementById("hit");
    if (hit instanceof HTMLElement) hit.style.color = "#eee";
    await wait(120);
    const after = getRuntimeStats();
    expect(after.undos - before.undos).toBe(0);
    expect(after.attributions - before.attributions).toBeLessThanOrEqual(1);
    expect(document.querySelector("[data-lift-css]")).not.toBeNull();
  });

  it("keeps focus on a promoted control while the page changes", async () => {
    document.body.innerHTML = `<div id="h" style="cursor:pointer;color:#111;background-color:#fff">Pay</div>`;
    expect(
      applyPatchSpec({
        id: "focus-keep",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#h", as: "button" }],
      }).ok,
    ).toBe(true);
    const host = document.getElementById("h");
    if (host instanceof HTMLElement) host.focus();
    expect(document.activeElement).toBe(host);
    if (host instanceof HTMLElement) host.style.color = "#eee";
    await wait(80);
    expect(document.activeElement).toBe(host);
    expect(host?.getAttribute("data-lift-promoted")).toBe("button");
  });

  it("keeps a user-opened disclosure open while the page changes", async () => {
    document.body.innerHTML = `
      <button type="button" id="tr">More</button>
      <div id="panel">Hidden</div>
    `;
    expect(
      applyPatchSpec({
        id: "disc",
        version: 0,
        ops: [{ op: "toggleDisclosure", trigger: "#tr", panel: "#panel" }],
      }).ok,
    ).toBe(true);
    document.getElementById("tr")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.getElementById("panel")?.classList.contains("lift-open")).toBe(true);
    const tr = document.getElementById("tr");
    if (tr instanceof HTMLElement) tr.style.color = "#eee";
    await wait(80);
    expect(document.getElementById("panel")?.classList.contains("lift-open")).toBe(true);
  });
});

describe("R11 W3/W4 spec-caused still undoes", () => {
  it("still undoes aria-label when visible text no longer matches", async () => {
    document.body.innerHTML = `<button type="button" id="pay">Checkout</button>`;
    expect(
      applyPatchSpec({
        id: "aria-checkout",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#pay", name: "aria-label", value: "Checkout" }],
      }).ok,
    ).toBe(true);
    const pay = document.getElementById("pay");
    if (pay) pay.textContent = "Checkout (2)";
    await wait(80);
    expect(document.getElementById("pay")?.hasAttribute("aria-label")).toBe(false);
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
    const sheet = document.querySelector("[data-lift-css]") as HTMLStyleElement | null;
    expect(!sheet || sheet.disabled).toBe(true);
  });

  it("still undoes overflow .item matches that fail contrast", async () => {
    const list = document.createElement("div");
    list.style.cssText = "background-color:#fff;color:#111";
    for (let i = 0; i < 10; i += 1) {
      const item = document.createElement("span");
      item.className = "item";
      item.textContent = "row";
      list.append(item);
    }
    document.body.append(list);
    expect(
      applyPatchSpec({
        id: "items",
        version: 0,
        ops: [
          css([
            {
              selector: { classes: ["item"] },
              declarations: [{ property: "color", value: "#111" }],
            },
          ]),
        ],
      }).ok,
    ).toBe(true);
    const dark = document.createElement("div");
    dark.style.cssText = "background-color:#111;color:#fff";
    for (let i = 0; i < 60; i += 1) {
      const item = document.createElement("span");
      item.className = "item";
      item.textContent = "ghost";
      dark.append(item);
    }
    document.body.append(dark);
    await wait(80);
    const sheet = document.querySelector("[data-lift-css]") as HTMLStyleElement | null;
    expect(!sheet || sheet.disabled).toBe(true);
  });
});

describe("R11 window capture before promote is once", () => {
  it("Enter and Space each fire one click when window capture clicks first", () => {
    document.body.innerHTML = `<div id="h" style="cursor:pointer">Pay</div>`;
    const host = document.getElementById("h");
    let clicks = 0;
    const onWin = (event: Event) => {
      if (event.target !== host) return;
      host?.click();
    };
    window.addEventListener("keydown", onWin, true);
    host?.addEventListener("click", () => {
      clicks += 1;
    });
    expect(
      applyPatchSpec({
        id: "pre-win",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#h", as: "button" }],
      }).ok,
    ).toBe(true);
    key(host, "keydown", "Enter");
    key(host, "keyup", "Enter");
    expect(clicks).toBe(1);
    clicks = 0;
    key(host, "keydown", " ");
    key(host, "keyup", " ");
    expect(clicks).toBe(1);
    window.removeEventListener("keydown", onWin, true);
  });
});

describe("R11 sticky host may grow to 44×44", () => {
  it("allows min-width/min-height 44px on a sticky host itself", () => {
    document.body.innerHTML = `<a id="hit" href="#x" style="position:sticky;top:0;display:inline-block;color:#111;background-color:#fff">Go</a>`;
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
    const hit = document.getElementById("hit") as HTMLElement;
    hit.getBoundingClientRect = () => box(0, 0, 44, 44) as DOMRect;
    expect(
      applyPatchSpec({
        id: "sticky-host-44",
        version: 0,
        ops: [
          css([
            {
              selector: { id: "hit" },
              declarations: [
                { property: "min-height", value: "44px" },
                { property: "min-width", value: "44px" },
              ],
            },
          ]),
        ],
      }).ok,
    ).toBe(true);
    expect(document.querySelector("[data-lift-css]")).not.toBeNull();
  });
});
