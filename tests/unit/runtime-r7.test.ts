/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it } from "vitest";
import { GUARD_MAX_WAIT_MS } from "../../runtime/patch-rules.js";
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

describe("R7 E1 replaceTag hosts and submit buttons", () => {
  it("refuses replaceTag on an existing submit button and leaves the form submittable", () => {
    document.body.innerHTML = `
      <form id="f">
        <button id="go" type="submit">Pay</button>
      </form>
    `;
    const form = document.getElementById("f") as HTMLFormElement;
    let submits = 0;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submits += 1;
    });
    expect(
      applyPatchSpec({
        id: "keep-submit",
        version: 0,
        ops: [{ op: "replaceTag", selector: "#go", tag: "button" }],
      }).ok,
    ).toBe(false);
    const go = document.getElementById("go") as HTMLButtonElement;
    expect(go?.tagName).toBe("BUTTON");
    expect(go?.getAttribute("type")).toBe("submit");
    go.click();
    expect(submits).toBe(1);
  });

  it("refuses replaceTag on headings, lists, labels, links, and form controls", () => {
    document.body.innerHTML = `
      <h2 id="h">Title</h2>
      <ul id="list"><li id="item">x</li></ul>
      <label id="lab">L</label>
      <a id="link" href="#x">Go</a>
      <input id="in">
      <span id="ok">Go</span>
    `;
    for (const id of ["h", "list", "item", "lab", "link", "in"]) {
      expect(
        applyPatchSpec({
          id: `rt-${id}`,
          version: 0,
          ops: [{ op: "replaceTag", selector: `#${id}`, tag: "button" }],
        }).ok,
        id,
      ).toBe(false);
    }
    expect(
      applyPatchSpec({
        id: "rt-ok",
        version: 0,
        ops: [{ op: "replaceTag", selector: "#ok", tag: "button" }],
      }).ok,
    ).toBe(true);
    expect(document.getElementById("ok")?.getAttribute("type")).toBe("button");
  });

  it("forces type=button only on newly created buttons from div/span", () => {
    document.body.innerHTML = `<div id="pay">Pay</div>`;
    expect(
      applyPatchSpec({
        id: "new-btn",
        version: 0,
        ops: [{ op: "replaceTag", selector: "#pay", tag: "button" }],
      }).ok,
    ).toBe(true);
    expect(document.getElementById("pay")?.getAttribute("type")).toBe("button");
  });
});

describe("R7 E2 any state is outline/decoration only", () => {
  it("rejects color on focus-within, disabled, and checked", () => {
    for (const state of ["focus-within", "disabled", "checked", "hover", "focus"]) {
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
});

describe("R7 W1 size-growing on fixed/overflow hosts", () => {
  it("refuses font-size/padding/line-height on a position:fixed host", () => {
    document.body.innerHTML = `<div class="bar" style="position:fixed;top:0;left:0">Cookies</div><button type="button" id="buy">Buy</button>`;
    expect(
      applyPatchSpec({
        id: "fixed-bar",
        version: 0,
        ops: [
          css([
            {
              selector: { classes: ["bar"] },
              declarations: [
                { property: "font-size", value: "48px" },
                { property: "padding", value: "24px" },
                { property: "line-height", value: 3 },
              ],
            },
          ]),
        ],
      }).ok,
    ).toBe(false);
    expect(document.querySelector("[data-lift-css]")).toBeNull();
  });

  it("refuses size-growing on a host with fixed height and overflow hidden", () => {
    document.body.innerHTML = `<div class="card" style="height:90px;overflow:hidden"><button type="button">Buy</button></div>`;
    expect(
      applyPatchSpec({
        id: "clip-card",
        version: 0,
        ops: [
          css([
            {
              selector: { classes: ["card"] },
              declarations: [{ property: "padding", value: "24px" }],
            },
          ]),
        ],
      }).ok,
    ).toBe(false);
  });
});

describe("R7 W2 form-control contrast", () => {
  it("undoes when a transparent input inside a painted panel fails contrast", () => {
    document.body.innerHTML = `<div class="panel">ok<input id="in" style="color:#fff;background:transparent"></div>`;
    const result = applyPatchSpec({
      id: "panel-in",
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
      ],
    });
    expect(result.ok).toBe(false);
    expect(document.querySelector("[data-lift-css]")).toBeNull();
  });
});

describe("R7 W3 / W5 / W8 extras", () => {
  it("caps mutation-guard wait at 250ms", () => {
    expect(GUARD_MAX_WAIT_MS).toBe(250);
  });
});

describe("R7 W5 guard zero matches keep the spec", () => {
  it("does not undo when a match disappears after apply", async () => {
    document.body.innerHTML = `<span id="title">Hello</span><span class="slot">ok</span>`;
    expect(
      applyPatchSpec({
        id: "keep-zero",
        version: 0,
        ops: [
          { op: "setText", selector: "#title", text: "Checkout" },
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
    document.querySelector(".slot")?.remove();
    await wait(80);
    expect(document.querySelector("[data-lift-css]")).not.toBeNull();
    expect(document.getElementById("title")?.textContent).toBe("Checkout");
  });
});

describe("R7 W7 label-in-name", () => {
  it("refuses an aria-label that drops visible text", () => {
    document.body.innerHTML = `<button type="button" id="go">Buy now</button>`;
    expect(
      applyPatchSpec({
        id: "mislabel",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#go", name: "aria-label", value: "Continue" }],
      }).ok,
    ).toBe(false);
    expect(document.getElementById("go")?.getAttribute("aria-label")).toBeNull();
  });

  it("refuses labelledby targets that are not rendered visible", () => {
    document.body.innerHTML = `<button type="button" id="go">x</button><span id="nm" hidden>Name</span>`;
    expect(
      applyPatchSpec({
        id: "hidden-by",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#go", name: "aria-labelledby", value: "nm" }],
      }).ok,
    ).toBe(false);
  });

  it("allows an aria-label that contains the visible text", () => {
    document.body.innerHTML = `<button type="button" id="go">Buy</button>`;
    expect(
      applyPatchSpec({
        id: "label-ok",
        version: 0,
        ops: [{ op: "setAttribute", selector: "#go", name: "aria-label", value: "Buy now" }],
      }).ok,
    ).toBe(true);
  });
});

describe("R7 W8 interactive ancestor and structural roles", () => {
  it("refuses replacing a span inside an anchor with a button", () => {
    document.body.innerHTML = `<a href="#x"><span id="inner">Go</span></a>`;
    expect(
      applyPatchSpec({
        id: "nested",
        version: 0,
        ops: [{ op: "replaceTag", selector: "#inner", tag: "button" }],
      }).ok,
    ).toBe(false);
    expect(document.getElementById("inner")?.tagName).toBe("SPAN");
  });
});

describe("R7 I1 guard dedupe", () => {
  it("re-applying the same spec id is allowed", () => {
    document.body.innerHTML = `<span class="slot">ok</span>`;
    const spec = {
      id: "same",
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
    };
    expect(applyPatchSpec(spec).ok).toBe(true);
    expect(applyPatchSpec(spec).ok).toBe(true);
    expect(document.querySelectorAll("[data-lift-css]")).toHaveLength(1);
  });
});

describe("R7 W4 attribute and style mutations", () => {
  it("undoes when a data-theme or body style change breaks contrast", async () => {
    document.body.innerHTML = `<span class="slot">ok</span>`;
    expect(
      applyPatchSpec({
        id: "theme",
        version: 0,
        ops: [
          css([
            {
              selector: { classes: ["slot"] },
              declarations: [{ property: "color", value: "#111" }],
            },
          ]),
        ],
      }).ok,
    ).toBe(true);
    document.body.setAttribute("style", "background:#000");
    document.documentElement.setAttribute("data-theme", "dark");
    await wait(80);
    expect(document.querySelector("[data-lift-css]")).toBeNull();
  });
});

describe("R7 W6 watch-node cap", () => {
  it("refuses to apply when the watched set exceeds 2000 nodes", () => {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 2001; i += 1) {
      const node = document.createElement("span");
      node.className = "n";
      frag.appendChild(node);
    }
    document.body.appendChild(frag);
    const result = applyPatchSpec({
      id: "cap",
      version: 0,
      ops: [
        css([
          {
            selector: { classes: ["n"] },
            declarations: [
              { property: "color", value: "#111" },
              { property: "background-color", value: "#fff" },
            ],
          },
        ]),
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected cap refuse");
    expect(result.error).toMatch(/2000|watched/i);
    expect(document.querySelector("[data-lift-css]")).toBeNull();
  });
});
