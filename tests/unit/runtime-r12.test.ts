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

function key(el: Element | null, type: string, keyName: string, extra: KeyboardEventInit = {}) {
  el?.dispatchEvent(
    new KeyboardEvent(type, { key: keyName, bubbles: true, cancelable: true, ...extra }),
  );
}

function minWidthSpec(id: string, selector: object, extraOps: object[] = []) {
  return {
    id,
    version: 0,
    ops: [
      css([
        {
          selector,
          declarations: [{ property: "min-width", value: "44px" }],
        },
      ]),
      ...extraOps,
    ],
  };
}

describe("R12 W5 attribution actually runs", () => {
  it("keeps focus and an open disclosure while injectCSS plus a page contrast change is attributed", async () => {
    document.body.innerHTML = `
      <div id="h" style="cursor:pointer;color:#111;background-color:#fff">Pay</div>
      <button type="button" id="tr">More</button>
      <div id="panel">Hidden</div>
    `;
    expect(
      applyPatchSpec({
        id: "attr-state",
        version: 0,
        ops: [
          { op: "promoteToControl", selector: "#h", as: "button" },
          { op: "toggleDisclosure", trigger: "#tr", panel: "#panel" },
          css([
            {
              selector: { id: "h" },
              declarations: [{ property: "min-width", value: "44px" }],
            },
          ]),
        ],
      }).ok,
    ).toBe(true);
    const host = document.getElementById("h");
    if (host instanceof HTMLElement) host.focus();
    expect(document.activeElement).toBe(host);
    document.getElementById("tr")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.getElementById("panel")?.classList.contains("lift-open")).toBe(true);
    const before = getRuntimeStats();
    if (host instanceof HTMLElement) host.style.color = "#eee";
    await wait(120);
    const after = getRuntimeStats();
    expect(after.attributions - before.attributions).toBeGreaterThanOrEqual(1);
    expect(after.undos - before.undos).toBe(0);
    expect(document.activeElement).toBe(host);
    expect(document.getElementById("panel")?.classList.contains("lift-open")).toBe(true);
    expect(host?.getAttribute("data-lift-promoted")).toBe("button");
  });
});

describe("R12 W2 own-property click is chained and restored", () => {
  it("chains to the page's own el.click and restores that descriptor on undo", () => {
    document.body.innerHTML = `<div id="h" style="cursor:pointer">Pay</div>`;
    const host = document.getElementById("h") as HTMLElement;
    let pageClicks = 0;
    const original = function pageClick(this: HTMLElement) {
      pageClicks += 1;
      HTMLElement.prototype.click.call(this);
    };
    Object.defineProperty(host, "click", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: original,
    });
    expect(
      applyPatchSpec({
        id: "chain-click",
        version: 0,
        ops: [
          { op: "promoteToControl", selector: "#h", as: "button" },
          { op: "setAttribute", selector: "#missing", name: "aria-label", value: "x" },
        ],
      }).ok,
    ).toBe(false);
    const desc = Object.getOwnPropertyDescriptor(host, "click");
    expect(desc?.value).toBe(original);
    host.click();
    expect(pageClicks).toBe(1);
  });

  it("calls the previous own-property click while the spec is applied", () => {
    document.body.innerHTML = `<div id="h" style="cursor:pointer">Pay</div>`;
    const host = document.getElementById("h") as HTMLElement;
    let pageClicks = 0;
    Object.defineProperty(host, "click", {
      configurable: true,
      enumerable: false,
      writable: true,
      value() {
        pageClicks += 1;
        HTMLElement.prototype.click.call(this);
      },
    });
    expect(
      applyPatchSpec({
        id: "chain-live",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#h", as: "button" }],
      }).ok,
    ).toBe(true);
    host.click();
    expect(pageClicks).toBe(1);
  });
});

describe("R12 P4 Enter is once", () => {
  it("P4a window capture synthetic click yields one Enter activation", async () => {
    document.body.innerHTML = `<div id="h" style="cursor:pointer">Pay</div>`;
    const host = document.getElementById("h");
    let clicks = 0;
    const onWin = (event: Event) => {
      if (event.target !== host) return;
      host?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    };
    window.addEventListener("keydown", onWin, true);
    host?.addEventListener("click", () => {
      clicks += 1;
    });
    expect(
      applyPatchSpec({
        id: "p4a",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#h", as: "button" }],
      }).ok,
    ).toBe(true);
    key(host, "keydown", "Enter");
    await wait(0);
    expect(clicks).toBe(1);
    window.removeEventListener("keydown", onWin, true);
  });

  it("P4b host keydown added after promote yields one Enter activation", async () => {
    document.body.innerHTML = `<div id="h" style="cursor:pointer">Pay</div>`;
    const host = document.getElementById("h");
    let clicks = 0;
    host?.addEventListener("click", () => {
      clicks += 1;
    });
    expect(
      applyPatchSpec({
        id: "p4b",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#h", as: "button" }],
      }).ok,
    ).toBe(true);
    host?.addEventListener("keydown", () => {
      (host as HTMLElement).click();
    });
    key(host, "keydown", "Enter");
    await wait(0);
    expect(clicks).toBe(1);
  });

  it("P4d window capture synthetic click yields one Space activation", async () => {
    document.body.innerHTML = `<div id="h" style="cursor:pointer">Pay</div>`;
    const host = document.getElementById("h");
    let clicks = 0;
    const onWin = (event: Event) => {
      if (event.target !== host) return;
      host?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    };
    window.addEventListener("keydown", onWin, true);
    host?.addEventListener("click", () => {
      clicks += 1;
    });
    expect(
      applyPatchSpec({
        id: "p4d",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#h", as: "button" }],
      }).ok,
    ).toBe(true);
    key(host, "keydown", " ");
    key(host, "keyup", " ");
    await wait(0);
    expect(clicks).toBe(1);
    window.removeEventListener("keydown", onWin, true);
  });

  it("P4e bindEnterToClick with a window-capture synthetic click fires once", async () => {
    document.body.innerHTML = `<div id="h">Pay</div>`;
    const host = document.getElementById("h");
    let clicks = 0;
    const onWin = (event: Event) => {
      if (event.target !== host) return;
      host?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    };
    window.addEventListener("keydown", onWin, true);
    host?.addEventListener("click", () => {
      clicks += 1;
    });
    expect(
      applyPatchSpec({
        id: "p4e",
        version: 0,
        ops: [{ op: "bindEnterToClick", selector: "#h" }],
      }).ok,
    ).toBe(true);
    key(host, "keydown", "Enter");
    await wait(0);
    expect(clicks).toBe(1);
    window.removeEventListener("keydown", onWin, true);
  });
});

describe("R13 document-level keydown click is once", () => {
  it("defers Lift's click until after a document handler calls target.click", async () => {
    document.body.innerHTML = `<div id="h" style="cursor:pointer">Pay</div>`;
    const host = document.getElementById("h");
    let clicks = 0;
    const onDoc = (event: Event) => {
      if (event.target === host) (host as HTMLElement).click();
    };
    document.addEventListener("keydown", onDoc);
    host?.addEventListener("click", () => {
      clicks += 1;
    });
    expect(
      applyPatchSpec({
        id: "r13-doc",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#h", as: "button" }],
      }).ok,
    ).toBe(true);
    key(host, "keydown", "Enter");
    await wait(0);
    expect(clicks).toBe(1);
    document.removeEventListener("keydown", onDoc);
  });
});

describe("R12 loop still stays quiet", () => {
  it("page #eee on a min-width spec does not undo", async () => {
    document.body.innerHTML = `<a id="hit" href="#x" style="color:#111;background-color:#fff">Go</a>`;
    expect(applyPatchSpec(minWidthSpec("minw", { id: "hit" })).ok).toBe(true);
    const before = getRuntimeStats();
    const hit = document.getElementById("hit");
    if (hit instanceof HTMLElement) hit.style.color = "#eee";
    await wait(120);
    const after = getRuntimeStats();
    expect(after.undos - before.undos).toBe(0);
    expect(document.querySelector("[data-lift-css]")).not.toBeNull();
  });
});
