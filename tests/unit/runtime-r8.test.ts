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

describe("R8 E1 cumulative undos survive a noop re-apply", () => {
  it("keeps the first apply's undos when the second apply is a noop, then undoes after .dark", async () => {
    document.body.innerHTML = `
      <style>.panel.dark { color: #fff; background: #fff; }</style>
      <div id="panel" class="panel">Hello</div>
    `;
    const spec = {
      id: "reapply-guard",
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
    };
    expect(applyPatchSpec(spec).ok).toBe(true);
    expect(applyPatchSpec(spec).ok).toBe(true);
    expect(document.querySelector("[data-lift-css]")).not.toBeNull();
    document.getElementById("panel")?.classList.add("dark");
    await wait(80);
    expect(document.querySelector("[data-lift-css]")).toBeNull();
  });
});

describe("R8 E2 guard continues when the first selector vanished", () => {
  it("still checks a later rule after the first match is gone", async () => {
    document.body.innerHTML = `<span id="gone">A</span><span class="keep">B</span>`;
    expect(
      applyPatchSpec({
        id: "two-rules",
        version: 0,
        ops: [
          css([
            {
              selector: { id: "gone" },
              declarations: [
                { property: "color", value: "#111" },
                { property: "background-color", value: "#fff" },
              ],
            },
            {
              selector: { classes: ["keep"] },
              declarations: [
                { property: "color", value: "#111" },
                { property: "background-color", value: "#fff" },
              ],
            },
          ]),
        ],
      }).ok,
    ).toBe(true);
    document.getElementById("gone")?.remove();
    const keep = document.querySelector(".keep");
    if (keep instanceof HTMLElement) {
      keep.style.color = "#fff";
      keep.style.backgroundColor = "#fff";
    }
    await wait(80);
    expect(document.querySelector("[data-lift-css]")).toBeNull();
  });
});

describe("R8 W1 size-growing extras and out-of-flow hosts", () => {
  it("refuses min-height, min-width, and border-width on fixed, sticky, and absolute hosts", () => {
    document.body.innerHTML = `
      <div class="fixed" style="position:fixed;top:0">x</div>
      <div class="sticky" style="position:sticky;top:0">x</div>
      <div class="abs" style="position:absolute;top:0">x</div>
    `;
    for (const cls of ["fixed", "sticky", "abs"]) {
      for (const property of ["min-height", "min-width", "border-width"] as const) {
        expect(
          applyPatchSpec({
            id: `grow-${cls}-${property}`,
            version: 0,
            ops: [
              css([
                {
                  selector: { classes: [cls] },
                  declarations: [{ property, value: property === "border-width" ? "4px" : "64px" }],
                },
              ]),
            ],
          }).ok,
          `${cls} ${property}`,
        ).toBe(false);
      }
    }
    expect(document.querySelector("[data-lift-css]")).toBeNull();
  });
});

describe("R8 W2 CSSOM and media watch", () => {
  it("keeps the CSSOM watch after insertRule/resize so a later contrast break still undoes", async () => {
    document.head.insertAdjacentHTML(
      "beforeend",
      `<style>.slot.dark { color: #fff; background: #fff; }</style>`,
    );
    document.body.innerHTML = `<span class="slot">ok</span>`;
    expect(
      applyPatchSpec({
        id: "cssom",
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
    const style = document.querySelector("[data-lift-css]") as HTMLStyleElement | null;
    const sheet = style?.sheet;
    expect(sheet).not.toBeNull();
    sheet?.insertRule(".slot { color: rgb(255, 255, 255); }", sheet.cssRules.length);
    window.dispatchEvent(new Event("resize"));
    document.dispatchEvent(new Event("visibilitychange"));
    await wait(80);
    expect(document.querySelector("[data-lift-css]")).not.toBeNull();
    document.querySelector(".slot")?.classList.add("dark");
    await wait(80);
    expect(document.querySelector("[data-lift-css]")).toBeNull();
  });
});

describe("R8 W3 line-through decoration", () => {
  it("refuses text-decoration-line underline on struck text and inside del", () => {
    document.body.innerHTML = `
      <span class="struck" style="text-decoration-line:line-through">old</span>
      <del class="deleted">gone</del>
    `;
    expect(
      applyPatchSpec({
        id: "underline-struck",
        version: 0,
        ops: [
          css([
            {
              selector: { classes: ["struck"] },
              declarations: [{ property: "text-decoration-line", value: "underline" }],
            },
          ]),
        ],
      }).ok,
    ).toBe(false);
    expect(
      applyPatchSpec({
        id: "underline-del",
        version: 0,
        ops: [
          css([
            {
              selector: { classes: ["deleted"] },
              declarations: [{ property: "text-decoration-line", value: "underline" }],
            },
          ]),
        ],
      }).ok,
    ).toBe(false);
  });
});

describe("R8 W4 outline budget", () => {
  it("refuses outline-width plus outline-offset over 4px", () => {
    const parsed = parsePatchSpec({
      id: "outline-sum",
      version: 0,
      ops: [
        css([
          {
            selector: { classes: ["x"], state: "focus" },
            declarations: [
              { property: "outline-style", value: "solid" },
              { property: "outline-color", value: "#000" },
              { property: "outline-width", value: "3px" },
              { property: "outline-offset", value: "2px" },
            ],
          },
        ]),
      ],
    });
    expect(parsed.ok).toBe(false);
  });
});

describe("R8 promoteToControl hosts", () => {
  it("parse-rejects replaceTag with a clear message", () => {
    const parsed = parsePatchSpec({
      id: "gone",
      version: 0,
      ops: [{ op: "replaceTag", selector: "#x", tag: "button" }],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("promoteToControl");
  });

  it("refuses headings, block children, interactive ancestors, and missing click affordance", () => {
    document.body.innerHTML = `
      <h2 id="h">Title</h2>
      <div id="blocked" style="cursor:pointer"><p>block</p></div>
      <a href="#x"><span id="nested">Go</span></a>
      <div id="plain">Pay</div>
      <div id="ok" style="cursor:pointer">Pay</div>
    `;
    expect(
      applyPatchSpec({
        id: "h",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#h", as: "button", hasClickAffordance: true }],
      }).ok,
    ).toBe(false);
    expect(
      applyPatchSpec({
        id: "blocked",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#blocked", as: "button" }],
      }).ok,
    ).toBe(false);
    expect(
      applyPatchSpec({
        id: "nested",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#nested", as: "button", hasClickAffordance: true }],
      }).ok,
    ).toBe(false);
    expect(
      applyPatchSpec({
        id: "plain",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#plain", as: "button" }],
      }).ok,
    ).toBe(false);
    expect(
      applyPatchSpec({
        id: "ok",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#ok", as: "button" }],
      }).ok,
    ).toBe(true);
    expect(document.getElementById("ok")?.getAttribute("role")).toBe("button");
  });

  it("Enter and Space call the host click exactly once and keep original handlers", () => {
    document.body.innerHTML = `<div id="acc" style="cursor:pointer">Toggle</div>`;
    const host = document.getElementById("acc");
    let clicks = 0;
    host?.addEventListener("click", () => {
      clicks += 1;
    });
    expect(
      applyPatchSpec({
        id: "acc",
        version: 0,
        ops: [{ op: "promoteToControl", selector: "#acc", as: "button" }],
      }).ok,
    ).toBe(true);
    host?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    host?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    host?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(clicks).toBe(3);
    expect(host?.tagName).toBe("DIV");
  });
});
