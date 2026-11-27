/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it } from "vitest";
import { applyPatchSpec, resetRuntimeGuards } from "../../runtime/runtime.js";

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

describe("R10 I1 grown host must stay inside sticky ancestor", () => {
  it("rejects min-height/min-width on a link that overflows a 40px sticky header over Buy", () => {
    document.body.innerHTML = `
      <header id="mast" style="position:sticky;top:0;height:40px;overflow:visible;background:#fff">
        <a id="hit" href="#x" style="display:inline-block">Go</a>
      </header>
      <button type="button" id="buy" style="width:64px;height:40px">Buy</button>
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
    const mast = document.getElementById("mast") as HTMLElement;
    const hit = document.getElementById("hit") as HTMLElement;
    const buy = document.getElementById("buy") as HTMLElement;
    mast.getBoundingClientRect = () => box(0, 0, 400, 40) as DOMRect;
    hit.getBoundingClientRect = () => box(0, 0, 64, 64) as DOMRect;
    buy.getBoundingClientRect = () => box(0, 40, 64, 40) as DOMRect;
    const applied = applyPatchSpec({
      id: "sticky-cover",
      version: 0,
      ops: [
        css([
          {
            selector: { id: "hit" },
            declarations: [
              { property: "min-height", value: "64px" },
              { property: "min-width", value: "64px" },
            ],
          },
        ]),
      ],
    });
    expect(applied.ok).toBe(false);
    expect(document.querySelector("[data-lift-css]")).toBeNull();
  });
});

describe("R10 W2 capture click does not double-activate", () => {
  it("skips the bridge when a host capture handler clicks without preventDefault", () => {
    document.body.innerHTML = `<div id="h" style="cursor:pointer">Pay</div>`;
    const host = document.getElementById("h");
    let clicks = 0;
    host?.addEventListener(
      "keydown",
      () => {
        host.click();
      },
      true,
    );
    host?.addEventListener("click", () => {
      clicks += 1;
    });
    expect(
      applyPatchSpec({
        id: "host-cap",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#h", as: "button" }],
      }).ok,
    ).toBe(true);
    key(host, "keydown", "Enter");
    expect(clicks).toBe(1);
  });

  it("skips the bridge when a document capture handler clicks without preventDefault", () => {
    document.body.innerHTML = `<div id="h" style="cursor:pointer">Pay</div>`;
    const host = document.getElementById("h");
    let clicks = 0;
    const onDoc = (event: Event) => {
      if (event.target !== host) return;
      host?.click();
    };
    document.addEventListener("keydown", onDoc, true);
    host?.addEventListener("click", () => {
      clicks += 1;
    });
    expect(
      applyPatchSpec({
        id: "doc-cap",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#h", as: "button" }],
      }).ok,
    ).toBe(true);
    key(host, "keydown", "Enter");
    document.removeEventListener("keydown", onDoc, true);
    expect(clicks).toBe(1);
  });

  it("skips the bridge when a bubble handler clicks without preventDefault", () => {
    document.body.innerHTML = `<div id="h" style="cursor:pointer">Pay</div>`;
    const host = document.getElementById("h");
    let clicks = 0;
    host?.addEventListener("keydown", () => {
      host.click();
    });
    host?.addEventListener("click", () => {
      clicks += 1;
    });
    expect(
      applyPatchSpec({
        id: "bubble-click",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#h", as: "button" }],
      }).ok,
    ).toBe(true);
    key(host, "keydown", "Enter");
    expect(clicks).toBe(1);
  });
});

describe("R10 W3 attribution reverts every op", () => {
  it("undoes aria-label when the page text no longer matches the name", async () => {
    document.body.innerHTML = `<button type="button" id="pay">Checkout</button>`;
    expect(
      applyPatchSpec({
        id: "aria-checkout",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#pay", name: "aria-label", value: "Checkout" }],
      }).ok,
    ).toBe(true);
    expect(document.getElementById("pay")?.getAttribute("aria-label")).toBe("Checkout");
    const pay = document.getElementById("pay");
    if (pay) pay.textContent = "Checkout (2)";
    await wait(80);
    expect(document.getElementById("pay")?.hasAttribute("aria-label")).toBe(false);
  });

  it("still keeps a color fix when a modal hides a watched control", async () => {
    document.body.innerHTML = `<button type="button" id="keep" class="keep">Keep</button>`;
    expect(applyPatchSpec(colorSpec("modal", { classes: ["keep"] })).ok).toBe(true);
    const keep = document.getElementById("keep");
    if (keep instanceof HTMLElement) keep.hidden = true;
    await wait(80);
    expect(document.querySelector("[data-lift-css]")).not.toBeNull();
  });

  it("still keeps a color fix when a wizard step hides the host", async () => {
    document.body.innerHTML = `<div class="step"><button type="button" class="next">Next</button></div>`;
    expect(applyPatchSpec(colorSpec("wizard", { classes: ["next"] })).ok).toBe(true);
    const step = document.querySelector(".step");
    if (step instanceof HTMLElement) step.style.display = "none";
    await wait(80);
    expect(document.querySelector("[data-lift-css]")).not.toBeNull();
  });
});

describe("R10 W4 overflow matches still get a contrast check", () => {
  it("undoes when new .item matches are #111 on #111 after the match cap", async () => {
    const list = document.createElement("div");
    list.id = "list";
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
    dark.id = "dark";
    dark.style.cssText = "background-color:#111;color:#fff";
    for (let i = 0; i < 60; i += 1) {
      const item = document.createElement("span");
      item.className = "item";
      item.textContent = "ghost";
      dark.append(item);
    }
    document.body.append(dark);
    await wait(80);
    expect(document.querySelector("[data-lift-css]")).toBeNull();
  });
});
