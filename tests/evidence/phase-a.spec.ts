import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { AXE_GATE_RULES } from "../../shared/patch-spec.ts";

async function pause(page: Page, ms = 1600) {
  await page.waitForTimeout(ms);
}

async function showBanner(page: Page, text: string) {
  await page.evaluate((message) => {
    let el = document.getElementById("lift-evidence-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "lift-evidence-banner";
      el.setAttribute("data-evidence", "1");
      el.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:14px 18px;font:600 18px/1.4 system-ui,sans-serif;background:#111;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.45)";
      document.body.prepend(el);
    }
    el.textContent = message;
  }, text);
  await pause(page);
}

async function axeSummary(page: Page) {
  const results = await new AxeBuilder({ page }).include("body").analyze();
  const gate = results.violations.filter((v) =>
    (AXE_GATE_RULES as readonly string[]).includes(v.id),
  );
  return {
    total: results.violations.length,
    gate: gate.map((v) => v.id),
    ids: results.violations.map((v) => v.id),
  };
}

async function openCheckoutWithHover(page: Page) {
  await page.locator(".hover-nav").hover();
  await pause(page, 600);
  await page.locator("#checkout-link").click();
  await page.locator("#checkout").waitFor({ state: "visible" });
}

async function openCheckoutWithKeyboard(page: Page) {
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.locator("#shop-trigger")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#shop-menu")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator("#checkout-link")).toBeFocused();
  await page.keyboard.press("Enter");
  await page.locator("#checkout").waitFor({ state: "visible" });
}

async function applyTreatment(page: Page) {
  return page.evaluate(async () => {
    const runtimeHref = new URL("/runtime/runtime.js", location.origin).href;
    const specHref = new URL("/runtime/checkout-treatment.json", location.origin).href;
    const runtime = (await import(runtimeHref)) as {
      applyPatchSpec: (spec: unknown) => { ok: boolean; error?: string };
    };
    const spec = await fetch(specHref).then((res) => res.json());
    return runtime.applyPatchSpec(spec);
  });
}

async function fillCheckout(page: Page) {
  await page.locator("#email").fill("ada@northline.test");
  await page.locator("#card-name").fill("Ada Lovelace");
  await page.locator("#card-number").fill("4242424242424242");
  await page.locator("#card-exp").fill("12/28");
  await page.locator("#card-cvc").fill("123");
}

async function paintIdentityReadout(page: Page) {
  return page.evaluate(() => {
    let el = document.getElementById("lift-cookie-readout");
    if (!el) {
      el = document.createElement("pre");
      el.id = "lift-cookie-readout";
      el.setAttribute("data-evidence", "1");
      el.style.cssText =
        "position:fixed;bottom:0;left:0;right:0;z-index:2147483647;margin:0;padding:12px 18px;font:16px/1.4 ui-monospace,monospace;background:#063;color:#fff;white-space:pre-wrap";
      document.body.append(el);
    }
    const cookie = document.cookie;
    const variant = document.body.getAttribute("data-variant") ?? "";
    const status = document.getElementById("flag-status")?.textContent ?? "";
    el.textContent = `document.cookie=${cookie}\ndata-variant=${variant}\n#flag-status=${status}`;
    return { cookie, variant, status, text: el.textContent };
  });
}

test("01-control-barriers", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await expect(page.locator("body")).toHaveAttribute("data-variant", "control");
  await showBanner(page, "CONTROL — hover to open Shop, unlabeled icon, unlabeled fields, low contrast, div Pay");
  await openCheckoutWithHover(page);
  const axe = await axeSummary(page);
  await showBanner(
    page,
    `CONTROL axe: ${axe.total} violations — gate [${axe.gate.join(", ") || "none"}]`,
  );
  for (const rule of AXE_GATE_RULES) {
    expect(axe.gate, `control should violate ${rule}`).toContain(rule);
  }
  await expect(page.locator("#shop-trigger")).toHaveJSProperty("tagName", "SPAN");
  await expect(page.locator("#place-order")).toHaveJSProperty("tagName", "DIV");
  await pause(page, 2000);
});

test("02-treatment-before-after", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckoutWithHover(page);
  const beforeAxe = await axeSummary(page);
  await showBanner(
    page,
    `BEFORE runtime spec — ${beforeAxe.total} axe violations, gate [${beforeAxe.gate.join(", ")}]`,
  );
  await expect(page.locator("#place-order")).toHaveJSProperty("tagName", "DIV");
  const applied = await applyTreatment(page);
  expect(applied.ok).toBe(true);
  await pause(page, 800);
  await expect(page.locator("#shop-trigger")).toHaveRole("button");
  await expect(page.locator('label[for="email"]')).toHaveText("Email");
  await expect(page.locator("#place-order")).toHaveRole("button");
  await expect(page.locator("#place-order")).toHaveText("Place order");
  const afterAxe = await axeSummary(page);
  const leftoverNote =
    "leftover region on .sim-banner — fixture demo note sits outside header/main landmarks; not a gate rule (label/button-name/color-contrast); promoteToControl cannot emit landmark tags";
  await showBanner(
    page,
    `AFTER runtime.js spec — ${afterAxe.total} axe violations (was ${beforeAxe.total}); gate [${afterAxe.gate.join(", ") || "cleared"}]; ${leftoverNote}`,
  );
  expect(beforeAxe.total, "control axe count").toBe(4);
  expect(afterAxe.gate, "treatment should clear the axe gate").toEqual([]);
  expect(afterAxe.ids, "one leftover non-gate region on the demo banner").toEqual(["region"]);
  expect(afterAxe.total, "treatment leftover axe count").toBe(1);
  await page.locator("#place-order").focus();
  await pause(page, 2000);
});

test("03-keyboard-submit-once", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await page.evaluate(() => {
    (window as unknown as { __payClicks: number }).__payClicks = 0;
    document.getElementById("place-order")?.addEventListener("click", () => {
      (window as unknown as { __payClicks: number }).__payClicks += 1;
    });
  });
  expect((await applyTreatment(page)).ok).toBe(true);
  await showBanner(
    page,
    "KEYBOARD — Tab to Shop, Enter opens menu (toggleDisclosure), Tab to Checkout, Enter, fill, Tab to Place order, one Enter. No mouse.",
  );
  await openCheckoutWithKeyboard(page);
  await fillCheckout(page);
  await page.keyboard.press("Tab");
  await expect(page.locator("#terms")).toBeFocused();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  await expect(page.locator("#place-order")).toBeFocused();
  await showBanner(page, "Place order focused — pressing Enter once");
  await page.keyboard.press("Enter");
  const clicks = await page.evaluate(
    () => (window as unknown as { __payClicks: number }).__payClicks,
  );
  expect(clicks).toBe(1);
  await expect(page.locator("#confirmation")).toBeVisible();
  await showBanner(page, `SUBMITTED — original click handlers fired ${clicks} time (want 1)`);
  await pause(page, 2000);
});

async function snapshotPage(page: Page) {
  return page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    for (const el of clone.querySelectorAll("[data-evidence]")) el.remove();
    return {
      pay: document.getElementById("place-order")?.outerHTML ?? "",
      html: clone.innerHTML,
      opacity: getComputedStyle(document.body).opacity,
      color: getComputedStyle(document.body).color,
    };
  });
}

async function applyAttack(
  page: Page,
  spec: unknown,
): Promise<{ ok: boolean; error?: string }> {
  return page.evaluate(async (input) => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    return runtime.applyPatchSpec(input);
  }, spec);
}

async function setBackstopsPaused(page: Page, paused: boolean) {
  const ok = await page.evaluate(async (value) => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      setTestBackstopsPaused: (paused: boolean) => boolean;
    };
    return runtime.setTestBackstopsPaused(value);
  }, paused);
  expect(ok, "loopback lift_bot=1 pause hook").toBe(true);
}

async function paintContrastReadout(
  page: Page,
  selector: string,
  caption: string,
  kind: "bad" | "restored",
) {
  await page.evaluate(
    ({ sel, cap, restored }) => {
      const parseRgb = (value: string) => {
        const m = String(value).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
      };
      const alphaOf = (value: string) => {
        const m = String(value).match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([0-9.]+)\s*\)/i);
        if (m) return Number(m[1]);
        return /rgba/i.test(value) ? 0 : 1;
      };
      const lin = (c: number) => {
        const n = c / 255;
        return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
      };
      const lum = (rgb: number[]) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
      const ratio = (fg: number[], bg: number[]) => {
        const a = lum(fg);
        const b = lum(bg);
        const hi = Math.max(a, b);
        const lo = Math.min(a, b);
        return (hi + 0.05) / (lo + 0.05);
      };
      const effectiveBg = (el: HTMLElement) => {
        let node: HTMLElement | null = el;
        while (node) {
          const raw = getComputedStyle(node).backgroundColor;
          const parsed = parseRgb(raw);
          const alpha = alphaOf(raw);
          if (parsed && Number.isFinite(alpha) && alpha >= 0.99) return parsed;
          node = node.parentElement;
        }
        return [255, 255, 255];
      };
      const el = document.querySelector(sel);
      if (!(el instanceof HTMLElement)) return;
      if (!restored) {
        el.style.outline = "3px dashed #f00";
        el.style.outlineOffset = "2px";
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      } else {
        window.getSelection()?.removeAllRanges();
        el.style.outline = "";
        el.style.outlineOffset = "";
      }
      const color = getComputedStyle(el).color;
      const fg = parseRgb(color) || [255, 255, 255];
      const bg = effectiveBg(el);
      const bgCss = `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`;
      const n = ratio(fg, bg);
      let capEl = document.getElementById("lift-bad-state");
      if (!capEl) {
        capEl = document.createElement("div");
        capEl.id = "lift-bad-state";
        capEl.setAttribute("data-evidence", "1");
        document.body.append(capEl);
      }
      capEl.style.cssText = restored
        ? "position:fixed;bottom:16px;left:16px;right:16px;z-index:2147483647;padding:12px 16px;font:600 16px/1.4 ui-monospace,monospace;background:#14532d;color:#fff;border:4px solid #22c55e"
        : "position:fixed;bottom:16px;left:16px;right:16px;z-index:2147483647;padding:12px 16px;font:600 16px/1.4 ui-monospace,monospace;background:#7f1d1d;color:#fff;border:4px dashed #f00";
      capEl.textContent = `${cap}\n${color} on ${bgCss} = ${n.toFixed(2)}:1`;
    },
    { sel: selector, cap: caption, restored: kind === "restored" },
  );
  await pause(page, 1500);
}

async function showGhostReadout(page: Page, selector: string, caption: string) {
  await paintContrastReadout(page, selector, caption, "bad");
}

async function showRestoredReadout(page: Page, selector: string, caption: string) {
  await paintContrastReadout(page, selector, caption, "restored");
}

async function markBadState(page: Page, selector: string, caption: string) {
  await page.evaluate(
    ({ sel, cap }) => {
      const el = document.querySelector(sel);
      if (el instanceof HTMLElement) {
        el.style.outline = "6px dashed #f00";
        el.style.outlineOffset = "6px";
      }
      let capEl = document.getElementById("lift-bad-state");
      if (!capEl) {
        capEl = document.createElement("div");
        capEl.id = "lift-bad-state";
        capEl.setAttribute("data-evidence", "1");
        capEl.style.cssText =
          "position:fixed;bottom:72px;left:24px;right:24px;z-index:2147483647;padding:18px 22px;font:800 32px/1.2 system-ui,sans-serif;background:#7f1d1d;color:#fff;border:6px dashed #f00;text-align:center";
        document.body.append(capEl);
      }
      capEl.textContent = cap;
    },
    { sel: selector, cap: caption },
  );
  await pause(page, 1500);
}

async function clearBadState(page: Page) {
  await page.evaluate(() => {
    document.getElementById("lift-bad-state")?.remove();
    window.getSelection()?.removeAllRanges();
  });
}

test("04-typed-body-tag", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckoutWithHover(page);
  const before = await snapshotPage(page);
  await showBanner(page, "FAIL-OPEN — typed injectCSS { tag: 'body' } is unrepresentable");
  const result = await applyAttack(page, {
    id: "evil-body-tag",
    version: 0,
    ops: [
      {
        op: "injectCSS",
        rules: [
          {
            selector: { tag: "body", classes: ["x"] },
            declarations: [{ property: "color", value: "#111" }],
          },
        ],
      },
    ],
  });
  expect(result.ok).toBe(false);
  const after = await snapshotPage(page);
  expect(after.pay).toBe(before.pay);
  expect(after.html).toBe(before.html);
  await showBanner(page, `REJECTED {tag:'body'} (${result.error ?? "not allowlisted"}) — page unchanged`);
  await pause(page, 2000);
});

test("04-typed-opacity", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckoutWithHover(page);
  const before = await snapshotPage(page);
  await showBanner(page, "FAIL-OPEN — typed property 'opacity' is unrepresentable");
  const result = await applyAttack(page, {
    id: "evil-opacity",
    version: 0,
    ops: [
      {
        op: "injectCSS",
        rules: [
          {
            selector: { classes: ["x"] },
            declarations: [{ property: "opacity", value: "0" }],
          },
        ],
      },
    ],
  });
  expect(result.ok).toBe(false);
  const after = await snapshotPage(page);
  expect(after.pay).toBe(before.pay);
  expect(after.opacity).toBe(before.opacity);
  expect(after.html).toBe(before.html);
  await showBanner(page, `REJECTED property:'opacity' (${result.error ?? "not allowlisted"}) — opacity ${after.opacity}`);
  await pause(page, 2000);
});

test("04-typed-not-state", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckoutWithHover(page);
  const before = await snapshotPage(page);
  await showBanner(page, "FAIL-OPEN — typed state 'not(x)' is unrepresentable");
  const result = await applyAttack(page, {
    id: "evil-not",
    version: 0,
    ops: [
      {
        op: "injectCSS",
        rules: [
          {
            selector: { classes: ["x"], state: "not(x)" },
            declarations: [{ property: "color", value: "#111" }],
          },
        ],
      },
    ],
  });
  expect(result.ok).toBe(false);
  const after = await snapshotPage(page);
  expect(after.pay).toBe(before.pay);
  expect(after.html).toBe(before.html);
  await showBanner(page, `REJECTED state:'not(x)' (${result.error ?? "not allowlisted"}) — page unchanged`);
  await pause(page, 2000);
});

test("04-typed-body-class-anchor", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckoutWithHover(page);
  await page.evaluate(() => document.body.classList.add("lift-atk"));
  const before = await snapshotPage(page);
  await showBanner(page, "FAIL-OPEN — class anchor matching <body class> is undone at apply time");
  const result = await applyAttack(page, {
    id: "evil-body-class",
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
  const after = await snapshotPage(page);
  expect(after.pay).toBe(before.pay);
  expect(after.color).toBe(before.color);
  await showBanner(
    page,
    `REJECTED body class anchor (${result.error ?? "apply-time host backstop"}) — body color unchanged`,
  );
  await pause(page, 2000);
});

test("04-typed-color-eq-background", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckoutWithHover(page);
  const before = await snapshotPage(page);
  await showBanner(page, "FAIL-OPEN — color == background-color (#fff/#fff) is rejected");
  const result = await applyAttack(page, {
    id: "evil-contrast",
    version: 0,
    ops: [
      {
        op: "injectCSS",
        rules: [
          {
            selector: { classes: ["x"] },
            declarations: [
              { property: "color", value: "#fff" },
              { property: "background-color", value: "#fff" },
            ],
          },
        ],
      },
    ],
  });
  expect(result.ok).toBe(false);
  const after = await snapshotPage(page);
  expect(after.pay).toBe(before.pay);
  expect(after.html).toBe(before.html);
  await showBanner(
    page,
    `REJECTED color==background (${result.error ?? "not allowlisted"}) — page unchanged`,
  );
  await pause(page, 2000);
});

test("04-typed-hover-invisible", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckoutWithHover(page);
  const before = await snapshotPage(page);
  await showBanner(page, "FAIL-OPEN — state rule hover { color } is unrepresentable");
  const result = await applyAttack(page, {
    id: "evil-hover-color",
    version: 0,
    ops: [
      {
        op: "injectCSS",
        rules: [
          {
            selector: { classes: ["div-pay"], state: "hover" },
            declarations: [{ property: "color", value: "#fff" }],
          },
        ],
      },
    ],
  });
  expect(result.ok).toBe(false);
  const after = await snapshotPage(page);
  expect(after.pay).toBe(before.pay);
  expect(after.html).toBe(before.html);
  await showBanner(
    page,
    `REJECTED hover color (${result.error ?? "not allowlisted"}) — page unchanged`,
  );
  await pause(page, 2000);
});

test("04-replace-button-to-span", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckoutWithHover(page);
  expect((await applyTreatment(page)).ok).toBe(true);
  await expect(page.locator("#place-order")).toHaveJSProperty("tagName", "DIV");
  await expect(page.locator("#place-order")).toHaveAttribute("role", "button");
  await showBanner(page, "FAIL-OPEN — replaceTag is parse-rejected; Place order stays the original DIV");
  const result = await applyAttack(page, {
    id: "evil-btn-span",
    version: 0,
    ops: [{ op: "replaceTag", selector: "#place-order", tag: "span" }],
  });
  expect(result.ok).toBe(false);
  await expect(page.locator("#place-order")).toHaveJSProperty("tagName", "DIV");
  await expect(page.locator("#place-order")).toHaveAttribute("role", "button");
  await showBanner(
    page,
    `REJECTED replaceTag (${result.error ?? "promoteToControl"}) — Place order stays DIV role=button`,
  );
  await pause(page, 2000);
});

test("04-late-content", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await openCheckoutWithHover(page);
  await showBanner(page, "MutationObserver — apply legal CSS, then inject late low-contrast text");
  const applied = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    const checkout = document.getElementById("checkout") || document.body;
    const theme = document.createElement("style");
    theme.textContent =
      ".lift-late-slot{color:#fff;background:#111;margin:12px 0;padding:8px 10px;border:1px dashed #888;font:14px/1.4 system-ui;max-width:100%}";
    document.head.append(theme);
    const host = document.createElement("div");
    host.className = "lift-late-slot";
    host.textContent = "Readable slot";
    checkout.append(host);
    return runtime.applyPatchSpec({
      id: "late-ok",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["lift-late-slot"] },
              declarations: [
                { property: "color", value: "#111" },
                { property: "background-color", value: "#fff" },
              ],
            },
          ],
        },
      ],
    });
  });
  expect(applied.ok).toBe(true);
  await setBackstopsPaused(page, true);
  await page.evaluate(() => {
    const slot = document.querySelector(".lift-late-slot");
    const ghost = document.createElement("span");
    ghost.className = "lift-ghost";
    ghost.textContent = "WHITE ON WHITE";
    ghost.style.cssText =
      "display:block;margin-top:6px;font:14px/1.4 system-ui,sans-serif;color:#fff;padding:4px";
    slot?.append(ghost);
  });
  await showGhostReadout(page, ".lift-ghost", "BAD STATE: white-on-white");
  await setBackstopsPaused(page, false);
  await page.waitForTimeout(80);
  const after = await page.evaluate(() => {
    const failOpen = (window as unknown as { __LIFT_FAIL_OPEN__?: { reason: string }[] })
      .__LIFT_FAIL_OPEN__;
    return {
      css: Boolean(document.querySelector("[data-lift-css]")),
      failOpen: failOpen?.length ?? 0,
      reason: failOpen?.[failOpen.length - 1]?.reason ?? "",
    };
  });
  expect(after.css).toBe(false);
  expect(after.failOpen).toBeGreaterThan(0);
  await showRestoredReadout(
    page,
    ".lift-ghost",
    `UNDONE (${after.reason || "contrast"}) — style removed, text readable again`,
  );
  await clearBadState(page);
  await pause(page, 800);
});

test("04-descendant-contrast", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await openCheckoutWithHover(page);
  const before = await snapshotPage(page);
  await showBanner(page, "FAIL-OPEN — parent contrast is fine, descendant ghost text is not");
  await setBackstopsPaused(page, true);
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    const checkout = document.getElementById("checkout") || document.body;
    const theme = document.createElement("style");
    theme.textContent =
      ".lift-card{color:#fff;background:#111;margin:12px 0;padding:8px 10px;border:1px dashed #888;font:14px/1.4 system-ui;max-width:100%;overflow:hidden}";
    document.head.append(theme);
    const host = document.createElement("div");
    host.className = "lift-card";
    host.append("Readable parent");
    const ghost = document.createElement("span");
    ghost.className = "lift-ghost";
    ghost.style.cssText = "display:block;margin-top:6px;font:14px/1.4 system-ui,sans-serif;color:#fff";
    ghost.textContent = "WHITE ON WHITE";
    host.append(ghost);
    checkout.append(host);
    return runtime.applyPatchSpec({
      id: "desc-contrast",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["lift-card"] },
              declarations: [{ property: "background-color", value: "#fff" }],
            },
          ],
        },
      ],
    });
  });
  expect(result.ok).toBe(true);
  await showGhostReadout(page, ".lift-ghost", "BAD STATE: white-on-white");
  await setBackstopsPaused(page, false);
  await page.waitForTimeout(80);
  expect(await page.evaluate(() => Boolean(document.querySelector("[data-lift-css]")))).toBe(false);
  const after = await snapshotPage(page);
  expect(after.pay).toBe(before.pay);
  await showRestoredReadout(page, ".lift-ghost", "UNDONE descendant contrast — injected CSS removed");
  await clearBadState(page);
  await expect(page.locator("#checkout-form")).toBeVisible();
  await pause(page, 800);
});

test("04-promote-keeps-handlers", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckoutWithHover(page);
  await showBanner(page, "promoteToControl keeps the original DIV and its click handler");
  const setup = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    const checkout = document.getElementById("checkout") || document.body;
    const wrap = document.createElement("div");
    wrap.id = "promo-acc";
    wrap.style.cssText = "margin:12px 0;max-width:100%";
    const trigger = document.createElement("div");
    trigger.id = "promo-toggle";
    trigger.style.cssText =
      "display:inline-block;padding:8px 12px;background:#111;color:#fff;cursor:pointer;font:600 16px/1.3 system-ui";
    trigger.textContent = "Shipping details";
    const panel = document.createElement("div");
    panel.id = "promo-panel";
    panel.hidden = true;
    panel.style.cssText = "margin-top:8px;padding:8px;border:1px solid #ccc;font:14px/1.4 system-ui";
    panel.textContent = "Ships in 2 days. Original click handler opened this accordion.";
    trigger.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
    });
    wrap.append(trigger, panel);
    checkout.append(wrap);
    const applied = runtime.applyPatchSpec({
      id: "promote-acc",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#promo-toggle", as: "button" }],
    });
    return {
      ok: applied.ok,
      error: applied.error,
      tag: trigger.tagName,
      role: trigger.getAttribute("role"),
    };
  });
  expect(setup.ok).toBe(true);
  expect(setup.tag).toBe("DIV");
  expect(setup.role).toBe("button");
  await page.locator("#promo-toggle").click();
  await expect(page.locator("#promo-panel")).toBeVisible();
  await showBanner(page, "MOUSE — original click handler opened the accordion");
  await page.locator("#promo-toggle").click();
  await expect(page.locator("#promo-panel")).toBeHidden();
  await page.locator("#promo-toggle").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#promo-panel")).toBeVisible();
  await showBanner(page, "KEYBOARD — Enter on the promoted DIV opened the accordion again");
  expect((await applyTreatment(page)).ok).toBe(true);
  await fillCheckout(page);
  await page.locator("#terms").check();
  await page.locator("#place-order").click();
  await expect(page.locator("#confirmation")).toBeVisible();
  await showBanner(page, "SUBMITTED — real checkout form showed order confirmation. No stray Pay now.");
  await expect(page.locator("#keep-submit")).toHaveCount(0);
  await pause(page, 2000);
});

test("04-focus-within-color", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckoutWithHover(page);
  await showBanner(page, "E2 — any selector.state may set only outline-* / text-decoration-*");
  const result = await applyAttack(page, {
    id: "fw-color",
    version: 0,
    ops: [
      {
        op: "injectCSS",
        rules: [
          {
            selector: { classes: ["div-pay"], state: "focus-within" },
            declarations: [{ property: "color", value: "#111" }],
          },
        ],
      },
    ],
  });
  expect(result.ok).toBe(false);
  await showBanner(
    page,
    `REJECTED focus-within color (${result.error ?? "not allowlisted"}) — page unchanged`,
  );
  await pause(page, 2000);
});

test("04-covered-control", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await openCheckoutWithHover(page);
  await showBanner(page, "W1 — enlarged fixed cookie bar covers Buy, then the spec is undone");
  await setBackstopsPaused(page, true);
  const applied = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    const buy = document.createElement("button");
    buy.id = "buy-now";
    buy.type = "button";
    buy.textContent = "Buy";
    buy.style.cssText =
      "position:fixed;top:240px;left:50%;transform:translateX(-50%);z-index:1;font:700 28px/1.2 system-ui;padding:12px 28px";
    const bar = document.createElement("div");
    bar.className = "cookie-bar";
    bar.textContent = "Cookies";
    bar.style.cssText =
      "position:fixed;top:200px;left:0;right:0;z-index:9;background:#111;color:#fff;font:600 16px/1.2 system-ui";
    document.body.append(bar, buy);
    return runtime.applyPatchSpec({
      id: "cover-bar",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["cookie-bar"] },
              declarations: [
                { property: "font-size", value: "48px" },
                { property: "padding", value: "24px" },
                { property: "min-height", value: "64px" },
                { property: "line-height", value: 3 },
              ],
            },
          ],
        },
      ],
    });
  });
  expect(applied.ok).toBe(true);
  await page.evaluate(() => {
    const buy = document.getElementById("buy-now");
    if (buy instanceof HTMLElement) {
      buy.style.outline = "6px solid #f00";
      buy.style.outlineOffset = "4px";
    }
  });
  await markBadState(page, "#buy-now", "BAD STATE: cookie bar covering Buy (outlined red)");
  await setBackstopsPaused(page, false);
  await page.waitForTimeout(80);
  const restored = await page.evaluate(() => {
    const buy = document.getElementById("buy-now");
    if (!buy) return { css: true, hitOk: false };
    const box = buy.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      css: Boolean(document.querySelector("[data-lift-css]")),
      hitOk: hit === buy || Boolean(buy.contains(hit)),
    };
  });
  expect(restored.css).toBe(false);
  expect(restored.hitOk).toBe(true);
  await page.evaluate(() => {
    const buy = document.getElementById("buy-now");
    if (buy instanceof HTMLElement) {
      buy.style.outline = "";
      buy.style.outlineOffset = "";
    }
  });
  await clearBadState(page);
  await showBanner(page, "UNDONE covering cookie bar — Buy is hittable again");
  await pause(page, 2000);
});

test("04-reapply-guard", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await openCheckoutWithHover(page);
  await showBanner(page, "E1 — apply the same spec twice, then a spec-caused ghost; undos must still fire");
  const applied = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    const checkout = document.getElementById("checkout") || document.body;
    const theme = document.createElement("style");
    theme.textContent = ".panel { color: #fff; background-color: #111; }";
    document.head.append(theme);
    const panel = document.createElement("div");
    panel.id = "panel";
    panel.className = "panel";
    panel.textContent = "Theme panel";
    panel.style.cssText =
      "margin:12px 0;padding:8px 10px;border:1px dashed #888;font:14px/1.4 system-ui";
    checkout.append(panel);
    const spec = {
      id: "reapply-guard",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["panel"] },
              declarations: [
                { property: "color", value: "#111" },
                { property: "background-color", value: "#fff" },
              ],
            },
          ],
        },
      ],
    };
    const first = runtime.applyPatchSpec(spec);
    const second = runtime.applyPatchSpec(spec);
    return { first: first.ok, second: second.ok };
  });
  expect(applied.first).toBe(true);
  expect(applied.second).toBe(true);
  await setBackstopsPaused(page, true);
  await page.evaluate(() => {
    const ghost = document.createElement("span");
    ghost.className = "lift-ghost";
    ghost.textContent = "WHITE ON WHITE";
    ghost.style.cssText =
      "display:block;margin-top:6px;font:14px/1.4 system-ui,sans-serif;color:#fff;padding:4px";
    document.getElementById("panel")?.append(ghost);
  });
  await showGhostReadout(page, ".lift-ghost", "BAD STATE: white-on-white after re-apply left undos");
  await setBackstopsPaused(page, false);
  await page.waitForTimeout(80);
  expect(await page.evaluate(() => Boolean(document.querySelector("[data-lift-css]")))).toBe(false);
  await expect(page.locator("#panel")).toContainText("Theme panel");
  await showRestoredReadout(page, "#panel", "UNDONE — Theme panel is readable again (effective background)");
  await clearBadState(page);
  await pause(page, 800);
});

test("04-cssom-insertRule", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await openCheckoutWithHover(page);
  await showBanner(page, "W2 — CSSOM insertRule is visible to the guard");
  const applied = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    const pageStyle = document.createElement("style");
    pageStyle.textContent = ".slot { color: #16181d; background-color: #fff; }";
    document.head.append(pageStyle);
    const checkout = document.getElementById("checkout") || document.body;
    const slot = document.createElement("span");
    slot.className = "slot";
    slot.textContent = "CSSOM slot";
    slot.style.cssText =
      "display:block;margin:12px 0;padding:8px 10px;border:1px dashed #888;font:14px/1.4 system-ui";
    checkout.append(slot);
    return runtime.applyPatchSpec({
      id: "cssom",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["slot"] },
              declarations: [
                { property: "color", value: "#111" },
                { property: "background-color", value: "#fff" },
              ],
            },
          ],
        },
      ],
    });
  });
  expect(applied.ok).toBe(true);
  await setBackstopsPaused(page, true);
  const inserted = await page.evaluate(() => {
    const style = document.querySelector("[data-lift-css]") as HTMLStyleElement | null;
    const sheet = style?.sheet;
    const idx = sheet?.insertRule(".slot { color: rgb(255, 255, 255); }", sheet.cssRules.length);
    const el = document.querySelector(".slot");
    return {
      idx,
      rules: sheet ? [...sheet.cssRules].map((r) => r.cssText) : [],
      color: el instanceof HTMLElement ? getComputedStyle(el).color : "",
      bg: el instanceof HTMLElement ? getComputedStyle(el).backgroundColor : "",
    };
  });
  expect(inserted.color, JSON.stringify(inserted)).toMatch(/255,\s*255,\s*255/);
  await showGhostReadout(page, ".slot", "BAD STATE: insertRule made white-on-white");
  const after = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      setTestBackstopsPaused: (paused: boolean) => boolean;
    };
    runtime.setTestBackstopsPaused(false);
    window.dispatchEvent(new Event("resize"));
    document.body.setAttribute("data-cssom-kick", "1");
    await new Promise((resolve) => setTimeout(resolve, 120));
    const el = document.querySelector(".slot");
    return {
      hasCss: Boolean(document.querySelector("[data-lift-css]")),
      color: el instanceof HTMLElement ? getComputedStyle(el).color : "",
      bg: el instanceof HTMLElement ? getComputedStyle(el).backgroundColor : "",
    };
  });
  expect(after.hasCss, JSON.stringify(after)).toBe(false);
  await showRestoredReadout(page, ".slot", "UNDONE CSSOM insertRule — injected stylesheet removed");
  await clearBadState(page);
  await pause(page, 800);
});

test("04-promote-no-double", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckoutWithHover(page);
  await showBanner(page, "W1 — host preventDefault()+click on Enter must activate exactly once");
  const setup = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    const checkout = document.getElementById("checkout") || document.body;
    const host = document.createElement("div");
    host.id = "no-double";
    host.style.cssText =
      "display:inline-block;margin:12px 0;padding:10px 16px;background:#111;color:#fff;cursor:pointer;font:700 18px/1.3 system-ui";
    host.textContent = "Activate";
    const counter = document.createElement("div");
    counter.id = "activation-count";
    counter.style.cssText = "font:700 28px/1.2 ui-monospace,monospace;margin:8px 0";
    counter.textContent = "activations: 0";
    let clicks = 0;
    host.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      host.click();
    });
    host.addEventListener("click", () => {
      clicks += 1;
      counter.textContent = `activations: ${clicks}`;
    });
    checkout.append(host, counter);
    return runtime.applyPatchSpec({
      id: "no-double",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#no-double", as: "button" }],
    });
  });
  expect(setup.ok).toBe(true);
  await page.locator("#no-double").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#activation-count")).toHaveText("activations: 1");
  await showBanner(page, "activations: 1 — host Enter handler plus bridge did not double-fire");
  await pause(page, 2000);
});

test("04-guard-page-modal", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await openCheckoutWithHover(page);
  await showBanner(page, "W3 — a page modal appears; the spec did not cause it, so the fix STAYS");
  const applied = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    const checkout = document.getElementById("checkout") || document.body;
    const keep = document.createElement("button");
    keep.type = "button";
    keep.id = "keep-fix";
    keep.className = "keep";
    keep.textContent = "Keep this contrast fix";
    keep.style.cssText = "display:block;margin:12px 0;padding:10px 16px;font:700 18px/1.3 system-ui";
    checkout.append(keep);
    return runtime.applyPatchSpec({
      id: "page-modal",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["keep"] },
              declarations: [
                { property: "color", value: "#111" },
                { property: "background-color", value: "#fff" },
              ],
            },
          ],
        },
      ],
    });
  });
  expect(applied.ok).toBe(true);
  await setBackstopsPaused(page, true);
  await page.evaluate(() => {
    const keep = document.getElementById("keep-fix");
    if (keep instanceof HTMLElement) keep.hidden = true;
    const modal = document.createElement("div");
    modal.id = "page-modal";
    modal.textContent = "Modal dialog";
    modal.style.cssText =
      "position:fixed;inset:20% 15%;z-index:20;background:#fff;color:#111;border:4px solid #111;padding:24px;font:700 22px/1.3 system-ui;box-shadow:0 12px 40px rgba(0,0,0,.4)";
    document.body.append(modal);
  });
  await showBanner(page, "page-caused, fix kept");
  await setBackstopsPaused(page, false);
  await page.waitForTimeout(80);
  const stayed = await page.evaluate(() => Boolean(document.querySelector("[data-lift-css]")));
  expect(stayed).toBe(true);
  await expect(page.locator("#page-modal")).toBeVisible();
  await showBanner(page, "page-caused, fix kept — injected CSS still present after the modal");
  await pause(page, 2000);
});

test("04-guard-spec-caused", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await openCheckoutWithHover(page);
  await showBanner(page, "W3 — a spec-caused white-on-white descendant is still undone");
  const applied = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    const checkout = document.getElementById("checkout") || document.body;
    const theme = document.createElement("style");
    theme.textContent = ".panel { color: #fff; background-color: #111; }";
    document.head.append(theme);
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.id = "spec-panel";
    panel.textContent = "Theme panel";
    panel.style.cssText =
      "margin:12px 0;padding:8px 10px;border:1px dashed #888;font:14px/1.4 system-ui";
    checkout.append(panel);
    return runtime.applyPatchSpec({
      id: "spec-caused",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["panel"] },
              declarations: [
                { property: "color", value: "#111" },
                { property: "background-color", value: "#fff" },
              ],
            },
          ],
        },
      ],
    });
  });
  expect(applied.ok).toBe(true);
  await setBackstopsPaused(page, true);
  await page.evaluate(() => {
    const ghost = document.createElement("span");
    ghost.className = "lift-ghost";
    ghost.textContent = "WHITE ON WHITE";
    ghost.style.cssText =
      "display:block;margin-top:6px;font:14px/1.4 system-ui,sans-serif;color:#fff;padding:4px";
    document.getElementById("spec-panel")?.append(ghost);
  });
  await showGhostReadout(page, ".lift-ghost", "BAD STATE: spec-caused white-on-white");
  await setBackstopsPaused(page, false);
  await page.waitForTimeout(80);
  expect(await page.evaluate(() => Boolean(document.querySelector("[data-lift-css]")))).toBe(false);
  await showRestoredReadout(page, "#spec-panel", "UNDONE spec-caused regression — panel readable again");
  await clearBadState(page);
  await pause(page, 800);
});

test("04-dropdown-keeps-fix", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await openCheckoutWithHover(page);
  await showBanner(page, "W4 — color fix on a nav; opening a submenu must not undo it");
  const applied = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    const checkout = document.getElementById("checkout") || document.body;
    const nav = document.createElement("div");
    nav.id = "color-nav";
    nav.className = "nav";
    nav.style.cssText =
      "position:relative;display:inline-block;padding:8px 14px;background:#fff;color:#111;font:700 18px/1.3 system-ui;border:1px solid #ccc";
    nav.textContent = "Shop";
    const buy = document.createElement("button");
    buy.type = "button";
    buy.id = "under-menu";
    buy.textContent = "Buy";
    buy.style.cssText = "display:block;margin-top:8px;padding:10px 18px;font:700 16px/1.2 system-ui";
    checkout.append(nav, buy);
    return runtime.applyPatchSpec({
      id: "nav-color",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["nav"] },
              declarations: [
                { property: "color", value: "#111" },
                { property: "background-color", value: "#fff" },
              ],
            },
          ],
        },
      ],
    });
  });
  expect(applied.ok).toBe(true);
  await setBackstopsPaused(page, true);
  await page.evaluate(() => {
    const menu = document.createElement("div");
    menu.id = "nav-submenu";
    menu.textContent = "Checkout";
    menu.style.cssText =
      "position:absolute;top:100%;left:0;width:240px;height:80px;background:#111;color:#fff;z-index:9;padding:12px;font:600 16px/1.3 system-ui";
    document.getElementById("color-nav")?.append(menu);
  });
  await showBanner(page, "submenu open over Buy — color fix kept");
  await setBackstopsPaused(page, false);
  await page.waitForTimeout(80);
  expect(await page.evaluate(() => Boolean(document.querySelector("[data-lift-css]")))).toBe(true);
  await expect(page.locator("#nav-submenu")).toBeVisible();
  await showBanner(page, "FIX KEPT — dropdown overlay was page-caused, not the spec");
  await pause(page, 2000);
});

test("05-sticky-identity", async ({ page }) => {
  await page.goto("/checkout/");
  await page.waitForTimeout(1500);
  const flagsmithReady = await page.evaluate(() => {
    const variant = document.body.getAttribute("data-variant");
    return variant === "control" || variant === "treatment";
  });
  if (!flagsmithReady) {
    await page.goto("/checkout/?lift_variant=control");
    await expect(page.locator("body")).toHaveAttribute("data-variant", "control");
  }
  const first = await paintIdentityReadout(page);
  expect(first.cookie).toMatch(/lift_vid=/);
  await showBanner(page, `IDENTITY first load (from page) ${first.text.replaceAll("\n", " | ")}`);
  await page.reload();
  if (!flagsmithReady) {
    await expect(page.locator("body")).toHaveAttribute("data-variant", "control");
  } else {
    await expect(page.locator("body")).toHaveAttribute("data-variant", first.variant);
  }
  const again = await paintIdentityReadout(page);
  expect(again.cookie).toBe(first.cookie);
  expect(again.variant).toBe(first.variant);
  await showBanner(page, `IDENTITY after reload (from page) ${again.text.replaceAll("\n", " | ")} — same document.cookie`);
  if (flagsmithReady) {
    await showBanner(
      page,
      "Variant stability is only meaningful with a live Flagsmith environment key. This run had one.",
    );
  } else {
    await showBanner(
      page,
      "Variant stability is only meaningful with a live Flagsmith environment key. This run used the mock control fallback.",
    );
  }
  await pause(page, 2000);
});
