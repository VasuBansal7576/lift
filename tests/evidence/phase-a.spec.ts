import { createRequire } from "node:module";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { AXE_GATE_RULES } from "../../shared/patch-spec.ts";

const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core/axe.min.js");

async function pause(page: Page, ms = 1600) {
  await page.waitForTimeout(ms);
}

async function logEvidence(page: Page, value: unknown) {
  await page.evaluate((v) => {
    console.log(v);
  }, value);
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
    const cookie = document.cookie;
    const variant = document.body.getAttribute("data-variant") ?? "";
    const status = document.getElementById("flag-status")?.textContent ?? "";
    const text = `document.cookie=${cookie}\ndata-variant=${variant}\n#flag-status=${status}`;
    return { cookie, variant, status, text };
  });
}

test("01-control-barriers", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await expect(page.locator("body")).toHaveAttribute("data-variant", "control");
  await pause(page);
  await openCheckoutWithHover(page);
  const axe = await axeSummary(page);
  await logEvidence(page, { axe: axe.ids, gate: axe.gate });
  await pause(page);
  for (const rule of AXE_GATE_RULES) {
    expect(axe.gate, `control should violate ${rule}`).toContain(rule);
  }
  await expect(page.locator("#shop-trigger")).toHaveJSProperty("tagName", "SPAN");
  await expect(page.locator("#place-order")).toHaveJSProperty("tagName", "DIV");
  await pause(page, 2000);
});

async function injectAxe(page: Page) {
  await page.addScriptTag({ path: axePath });
}

test("02-treatment-before-after", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckoutWithHover(page);
  await injectAxe(page);
  await pause(page, 1200);
  const beforeAxe = await axeSummary(page);
  await logEvidence(page, { axeBefore: beforeAxe.ids });
  await expect(page.locator("#place-order")).toHaveJSProperty("tagName", "DIV");
  await pause(page);
  const applied = await applyTreatment(page);
  expect(applied.ok).toBe(true);
  await pause(page, 1800);
  await expect(page.locator("#shop-trigger")).toHaveRole("button");
  await expect(page.locator('label[for="email"]')).toHaveText("Email");
  await expect(page.locator("#place-order")).toHaveRole("button");
  await expect(page.locator("#place-order")).toHaveText("Place order");
  await pause(page, 1200);
  const afterAxe = await axeSummary(page);
  await logEvidence(page, { axeAfter: afterAxe.ids });
  expect(beforeAxe.total, "control axe count").toBe(4);
  expect(afterAxe.gate, "treatment should clear the axe gate").toEqual([]);
  expect(afterAxe.ids, "one leftover non-gate region on the demo banner").toEqual(["region"]);
  expect(afterAxe.total, "treatment leftover axe count").toBe(1);
  await page.locator("#place-order").focus();
  await pause(page, 1800);
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
  await pause(page);
  await openCheckoutWithKeyboard(page);
  await fillCheckout(page);
  await page.keyboard.press("Tab");
  await expect(page.locator("#terms")).toBeFocused();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  await expect(page.locator("#place-order")).toBeFocused();
  await pause(page);
  await page.keyboard.press("Enter");
  const clicks = await page.evaluate(
    () => (window as unknown as { __payClicks: number }).__payClicks,
  );
  expect(clicks).toBe(1);
  await expect(page.locator("#confirmation")).toBeVisible();
  await logEvidence(page, { clicks });
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

async function liftCssEnabled(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-lift-css]")].some(
      (el) => el instanceof HTMLStyleElement && !el.disabled,
    ),
  );
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
      const parseCssColor = (value: string): number[] | null => {
        const comma = String(value).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (comma) return [Number(comma[1]), Number(comma[2]), Number(comma[3])];
        const space = String(value).match(/rgba?\(\s*(\d+)\s+(\d+)\s+(\d+)/i);
        if (space) return [Number(space[1]), Number(space[2]), Number(space[3])];
        const hex = String(value).trim();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.fillStyle = "#000";
        ctx.fillStyle = hex;
        const canonical = String(ctx.fillStyle);
        const parsed = canonical.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        return parsed ? [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])] : null;
      };
      const lin = (c: number) => {
        const n = c / 255;
        return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
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
          const parsed = parseCssColor(raw) || parseRgb(raw);
          const alpha = alphaOf(raw);
          if (parsed && (Number.isNaN(alpha) || alpha >= 0.99)) return parsed;
          node = node.parentElement;
        }
        return [255, 255, 255];
      };
      const el = document.querySelector(sel);
      if (!(el instanceof HTMLElement)) return;
      if (!restored) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      } else {
        window.getSelection()?.removeAllRanges();
      }
      const color = getComputedStyle(el).color;
      const fg = parseCssColor(color) || parseRgb(color) || [255, 255, 255];
      const bg = effectiveBg(el);
      const bgCss = `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`;
      const n = ratio(fg, bg);
      console.log(`${cap}\n${color} on ${bgCss} = ${n.toFixed(2)}:1`);
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
  await page.evaluate((cap) => {
    console.log(cap);
  }, caption);
  await pause(page, 1500);
}

async function clearBadState(page: Page) {
  await page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
  });
}

test("04-typed-body-tag", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckoutWithHover(page);
  const before = await snapshotPage(page);
  await pause(page);
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
  await pause(page);
  await pause(page, 2000);
});

test("04-typed-opacity", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckoutWithHover(page);
  const before = await snapshotPage(page);
  await pause(page);
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
  await pause(page);
  await pause(page, 2000);
});

test("04-typed-not-state", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckoutWithHover(page);
  const before = await snapshotPage(page);
  await pause(page);
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
  await pause(page);
  await pause(page, 2000);
});

test("04-typed-body-class-anchor", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckoutWithHover(page);
  await page.evaluate(() => document.body.classList.add("lift-atk"));
  const before = await snapshotPage(page);
  await pause(page);
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
  await pause(page);
  await pause(page, 2000);
});

test("04-typed-color-eq-background", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckoutWithHover(page);
  const before = await snapshotPage(page);
  await pause(page);
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
  await pause(page);
  await pause(page, 2000);
});

test("04-typed-hover-invisible", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckoutWithHover(page);
  const before = await snapshotPage(page);
  await pause(page);
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
  await pause(page);
  await pause(page, 2000);
});

test("04-replace-button-to-span", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckoutWithHover(page);
  expect((await applyTreatment(page)).ok).toBe(true);
  await expect(page.locator("#place-order")).toHaveJSProperty("tagName", "DIV");
  await expect(page.locator("#place-order")).toHaveAttribute("role", "button");
  await pause(page);
  const result = await applyAttack(page, {
    id: "evil-btn-span",
    version: 0,
    ops: [{ op: "replaceTag", selector: "#place-order", tag: "span" }],
  });
  expect(result.ok).toBe(false);
  await expect(page.locator("#place-order")).toHaveJSProperty("tagName", "DIV");
  await expect(page.locator("#place-order")).toHaveAttribute("role", "button");
  await pause(page);
  await pause(page, 2000);
});

test("04-late-content", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await openCheckoutWithHover(page);
  await pause(page);
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
      css: [...document.querySelectorAll("[data-lift-css]")].some(
        (el) => el instanceof HTMLStyleElement && !el.disabled,
      ),
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
  await pause(page);
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
  expect(await liftCssEnabled(page)).toBe(false);
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
  await pause(page);
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
  await pause(page);
  await page.locator("#promo-toggle").click();
  await expect(page.locator("#promo-panel")).toBeHidden();
  await page.locator("#promo-toggle").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#promo-panel")).toBeVisible();
  await pause(page);
  expect((await applyTreatment(page)).ok).toBe(true);
  await fillCheckout(page);
  await page.locator("#terms").check();
  await page.locator("#place-order").click();
  await expect(page.locator("#confirmation")).toBeVisible();
  await pause(page);
  await expect(page.locator("#keep-submit")).toHaveCount(0);
  await pause(page, 2000);
});

test("04-focus-within-color", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckoutWithHover(page);
  await pause(page);
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
  await pause(page);
  await pause(page, 2000);
});

test("04-covered-control", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await openCheckoutWithHover(page);
  await pause(page);
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
      css: [...document.querySelectorAll("[data-lift-css]")].some(
        (el) => el instanceof HTMLStyleElement && !el.disabled,
      ),
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
  await pause(page);
  await pause(page, 2000);
});

test("04-reapply-guard", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await openCheckoutWithHover(page);
  await pause(page);
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
  expect(await liftCssEnabled(page)).toBe(false);
  await expect(page.locator("#panel")).toContainText("Theme panel");
  await showRestoredReadout(page, "#panel", "UNDONE — Theme panel is readable again (effective background)");
  await clearBadState(page);
  await pause(page, 800);
});

test("04-cssom-insertRule", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await openCheckoutWithHover(page);
  await pause(page);
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
      hasCss: [...document.querySelectorAll("[data-lift-css]")].some(
        (el) => el instanceof HTMLStyleElement && !el.disabled,
      ),
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
  await pause(page);
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
    (window as unknown as { __noDoubleClicks: number }).__noDoubleClicks = 0;
    host.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      host.click();
    });
    host.addEventListener("click", () => {
      (window as unknown as { __noDoubleClicks: number }).__noDoubleClicks += 1;
      console.log("clicks", (window as unknown as { __noDoubleClicks: number }).__noDoubleClicks);
    });
    checkout.append(host);
    return runtime.applyPatchSpec({
      id: "no-double",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#no-double", as: "button" }],
    });
  });
  expect(setup.ok).toBe(true);
  await page.locator("#no-double").focus();
  await page.keyboard.press("Enter");
  const activations = await page.evaluate(
    () => (window as unknown as { __noDoubleClicks: number }).__noDoubleClicks,
  );
  expect(activations).toBe(1);
  await logEvidence(page, { clicks: activations });
  await pause(page, 2000);
});

test("04-guard-page-modal", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await openCheckoutWithHover(page);
  await pause(page);
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
  await pause(page);
  await setBackstopsPaused(page, false);
  await page.waitForTimeout(80);
  const stayed = await page.evaluate(() => Boolean(document.querySelector("[data-lift-css]")));
  expect(stayed).toBe(true);
  await expect(page.locator("#page-modal")).toBeVisible();
  await pause(page);
  await pause(page, 2000);
});

test("04-guard-spec-caused", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await openCheckoutWithHover(page);
  await pause(page);
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
  expect(await liftCssEnabled(page)).toBe(false);
  await showRestoredReadout(page, "#spec-panel", "UNDONE spec-caused regression — panel readable again");
  await clearBadState(page);
  await pause(page, 800);
});

test("04-dropdown-keeps-fix", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await openCheckoutWithHover(page);
  await pause(page);
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
  await pause(page);
  await setBackstopsPaused(page, false);
  await page.waitForTimeout(80);
  expect(await page.evaluate(() => Boolean(document.querySelector("[data-lift-css]")))).toBe(true);
  await expect(page.locator("#nav-submenu")).toBeVisible();
  await pause(page);
  await pause(page, 2000);
});

test("04-sticky-hit-target-covers-rejected", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await openCheckoutWithHover(page);
  await pause(page);
  await setBackstopsPaused(page, true);
  const applied = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    const checkout = document.getElementById("checkout") || document.body;
    const header = document.createElement("header");
    header.id = "sticky-mast";
    header.style.cssText =
      "position:sticky;top:0;height:40px;overflow:visible;background:#fff;z-index:5;border:1px dashed #888";
    const link = document.createElement("a");
    link.id = "hit";
    link.href = "#x";
    link.textContent = "Go";
    link.style.cssText = "display:inline-block;color:#111;background:#cfc;font:700 16px/1 system-ui";
    header.append(link);
    const buy = document.createElement("button");
    buy.id = "buy-under";
    buy.type = "button";
    buy.textContent = "Buy";
    buy.style.cssText =
      "display:block;width:64px;height:40px;margin:0;padding:0;font:700 14px/40px system-ui";
    checkout.prepend(header, buy);
    return runtime.applyPatchSpec({
      id: "sticky-cover",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { id: "hit" },
              declarations: [
                { property: "min-height", value: "64px" },
                { property: "min-width", value: "64px" },
              ],
            },
          ],
        },
      ],
    });
  });
  expect(applied.ok).toBe(true);
  await page.evaluate(() => {
    const buy = document.getElementById("buy-under");
    if (buy instanceof HTMLElement) {
      buy.style.outline = "6px solid #f00";
      buy.style.outlineOffset = "2px";
    }
  });
  await markBadState(page, "#buy-under", "BAD STATE: grown #hit covers Buy (outlined red)");
  await setBackstopsPaused(page, false);
  await page.waitForTimeout(80);
  const restored = await page.evaluate(() => {
    const buy = document.getElementById("buy-under");
    if (!buy) return { css: true, hitOk: false };
    const box = buy.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      css: [...document.querySelectorAll("[data-lift-css]")].some(
        (el) => el instanceof HTMLStyleElement && !el.disabled,
      ),
      hitOk: hit === buy || Boolean(buy.contains(hit)),
    };
  });
  expect(restored.css).toBe(false);
  expect(restored.hitOk).toBe(true);
  await page.evaluate(() => {
    const buy = document.getElementById("buy-under");
    if (buy instanceof HTMLElement) {
      buy.style.outline = "";
      buy.style.outlineOffset = "";
    }
  });
  await clearBadState(page);
  await pause(page);
  await pause(page, 2000);
});

test("04-capture-click-no-double", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckoutWithHover(page);
  await pause(page);
  const setup = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    const checkout = document.getElementById("checkout") || document.body;
    const host = document.createElement("div");
    host.id = "cap-once";
    host.style.cssText =
      "display:inline-block;margin:12px 0;padding:10px 16px;background:#111;color:#fff;cursor:pointer;font:700 18px/1.3 system-ui";
    host.textContent = "Activate";
    (window as unknown as { __capClicks: number }).__capClicks = 0;
    host.addEventListener(
      "keydown",
      () => {
        host.click();
      },
      true,
    );
    host.addEventListener("click", () => {
      (window as unknown as { __capClicks: number }).__capClicks += 1;
      console.log("clicks", (window as unknown as { __capClicks: number }).__capClicks);
    });
    checkout.append(host);
    return runtime.applyPatchSpec({
      id: "cap-once",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#cap-once", as: "button" }],
    });
  });
  expect(setup.ok).toBe(true);
  await page.locator("#cap-once").focus();
  await page.keyboard.press("Enter");
  const capClicks = await page.evaluate(
    () => (window as unknown as { __capClicks: number }).__capClicks,
  );
  expect(capClicks).toBe(1);
  await logEvidence(page, { clicks: capClicks });
  await pause(page, 2000);
});

async function logLiveName(page: Page, selector: string) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!(el instanceof HTMLElement)) return;
    const name = (el.getAttribute("aria-label") || el.textContent || "").trim();
    console.log({
      computed: name,
      visible: (el.textContent || "").trim(),
      ariaLabel: el.getAttribute("aria-label") ?? "",
    });
  }, selector);
}

test("04-label-in-name-attributed", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await openCheckoutWithHover(page);
  await pause(page);
  const applied = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    const checkout = document.getElementById("checkout") || document.body;
    const pay = document.createElement("button");
    pay.type = "button";
    pay.id = "named-pay";
    pay.textContent = "Checkout";
    pay.style.cssText = "display:block;margin:12px 0;padding:10px 16px;font:700 18px/1.3 system-ui";
    checkout.append(pay);
    return runtime.applyPatchSpec({
      id: "aria-checkout",
      version: 0,
      ops: [{ op: "setAttribute", selector: "#named-pay", name: "aria-label", value: "Checkout" }],
    });
  });
  expect(applied.ok).toBe(true);
  await logLiveName(page, "#named-pay");
  await pause(page, 1200);
  await setBackstopsPaused(page, true);
  await page.evaluate(() => {
    const pay = document.getElementById("named-pay");
    if (pay instanceof HTMLElement) pay.textContent = "Checkout (2)";
  });
  await logLiveName(page, "#named-pay");
  await pause(page, 1600);
  await setBackstopsPaused(page, false);
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => {
    const pay = document.getElementById("named-pay");
    return { labelled: Boolean(pay?.hasAttribute("aria-label")), text: pay?.textContent ?? "" };
  });
  expect(after.labelled).toBe(false);
  await pause(page, 2000);
});

test("04-overflow-matches-contrast", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await openCheckoutWithHover(page);
  await pause(page);
  const applied = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    const checkout = document.getElementById("checkout") || document.body;
    const list = document.createElement("div");
    list.id = "item-list";
    list.style.cssText = "background-color:#fff;color:#111";
    for (let i = 0; i < 10; i += 1) {
      const item = document.createElement("span");
      item.className = "item";
      item.textContent = "row";
      list.append(item);
    }
    checkout.append(list);
    return runtime.applyPatchSpec({
      id: "items",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["item"] },
              declarations: [{ property: "color", value: "#111" }],
            },
          ],
        },
      ],
    });
  });
  expect(applied.ok).toBe(true);
  await setBackstopsPaused(page, true);
  await page.evaluate(() => {
    const checkout = document.getElementById("checkout") || document.body;
    const dark = document.createElement("div");
    dark.id = "dark-items";
    dark.style.cssText = "background-color:#111;color:#fff;padding:8px;margin:12px 0";
    for (let i = 0; i < 60; i += 1) {
      const item = document.createElement("span");
      item.className = "item";
      item.textContent = "Item";
      item.style.cssText = "display:block;font:14px/1.4 system-ui";
      dark.append(item);
    }
    checkout.append(dark);
  });
  await showGhostReadout(page, "#dark-items .item", "BAD STATE: overflow .item is #111 on #111");
  await setBackstopsPaused(page, false);
  await page.waitForTimeout(80);
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll("[data-lift-css]")].some(
        (el) => el instanceof HTMLStyleElement && !el.disabled,
      ),
    ),
  ).toBe(false);
  await showRestoredReadout(
    page,
    "#dark-items .item",
    "UNDONE overflow matches — effective background, items readable",
  );
  await clearBadState(page);
  await pause(page, 800);
});

test("04-page-contrast-no-loop", async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await openCheckoutWithHover(page);
  await pause(page);
  const applied = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
      getRuntimeStats: () => { undos: number; attributions: number };
    };
    const checkout = document.getElementById("checkout") || document.body;
    const hit = document.createElement("a");
    hit.id = "loop-hit";
    hit.href = "#x";
    hit.textContent = "Go";
    hit.style.cssText =
      "display:inline-block;padding:12px 18px;color:#111;background:#fff;font:700 22px/1.3 system-ui";
    checkout.append(hit);
    const applied = runtime.applyPatchSpec({
      id: "minw-loop",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { id: "loop-hit" },
              declarations: [{ property: "min-width", value: "44px" }],
            },
          ],
        },
      ],
    });
    const before = runtime.getRuntimeStats();
    let styleMutations = 0;
    let loads = 0;
    new MutationObserver((records) => {
      for (const rec of records) {
        if (rec.type === "attributes" && rec.attributeName === "style") styleMutations += 1;
      }
    }).observe(hit, { attributes: true, attributeFilter: ["style"] });
    document.addEventListener(
      "load",
      () => {
        loads += 1;
      },
      true,
    );
    let on = false;
    const flash = window.setInterval(() => {
      on = !on;
      hit.style.color = on ? "#eee" : "#111";
    }, 100);
    const started = Date.now();
    while (Date.now() - started < 8000) {
      const elapsed = (Date.now() - started) / 1000;
      const stats = runtime.getRuntimeStats();
      const mutPerSec = elapsed > 0 ? styleMutations / elapsed : 0;
      const loadPerSec = elapsed > 0 ? loads / elapsed : 0;
      console.log({
        styleMutationsPerSec: Number(mutPerSec.toFixed(1)),
        loadsPerSec: Number(loadPerSec.toFixed(2)),
        undos: stats.undos - before.undos,
        attributions: stats.attributions - before.attributions,
        elapsedSec: Number(elapsed.toFixed(1)),
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    window.clearInterval(flash);
    const after = runtime.getRuntimeStats();
    return {
      ok: applied.ok,
      css: [...document.querySelectorAll("[data-lift-css]")].some(
        (el) => el instanceof HTMLStyleElement && !el.disabled,
      ),
      undos: after.undos - before.undos,
    };
  });
  expect(applied.ok).toBe(true);
  expect(applied.css).toBe(true);
  expect(applied.undos).toBe(0);
  await pause(page, 800);
});

test("04-attribution-keeps-focus", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await openCheckoutWithHover(page);
  await pause(page);
  const setup = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const checkout = document.getElementById("checkout") || document.body;
    const host = document.createElement("div");
    host.id = "focus-keep";
    host.style.cssText =
      "display:inline-block;margin:12px 0;padding:12px 18px;background:#fff;color:#111;cursor:pointer;font:700 20px/1.3 system-ui;outline:4px solid #38bdf8;outline-offset:4px";
    host.textContent = "Pay now";
    const tr = document.createElement("button");
    tr.id = "tr";
    tr.type = "button";
    tr.textContent = "More";
    const panel = document.createElement("div");
    panel.id = "panel";
    panel.textContent = "Menu stays open";
    panel.style.cssText = "padding:8px;background:#fef3c7";
    const vis = document.createElement("style");
    vis.textContent = "#panel{display:none}#panel.lift-open{display:block;background:#fef3c7;padding:8px;border:3px dashed #22c55e}";
    document.head.append(vis);
    checkout.append(host, tr, panel);
    return runtime.applyPatchSpec({
      id: "focus-keep",
      version: 0,
      ops: [
        { op: "promoteToControl", selector: "#focus-keep", as: "button" },
        { op: "toggleDisclosure", trigger: "#tr", panel: "#panel" },
        {
          op: "injectCSS",
          rules: [
            {
              selector: { id: "focus-keep" },
              declarations: [{ property: "min-width", value: "44px" }],
            },
          ],
        },
      ],
    });
  });
  expect(setup.ok).toBe(true);
  await page.locator("#tr").click();
  await page.locator("#focus-keep").focus();
  await expect(page.locator("#focus-keep")).toBeFocused();
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      getRuntimeStats: () => { attributions: number; undos: number };
    };
    const host = document.getElementById("focus-keep");
    const panel = document.getElementById("panel");
    const before = runtime.getRuntimeStats();
    if (host instanceof HTMLElement) host.style.color = "#eee";
    const started = Date.now();
    while (Date.now() - started < 2500) {
      const stats = runtime.getRuntimeStats();
      console.log({
        attributions: stats.attributions - before.attributions,
        undos: stats.undos - before.undos,
        focused: document.activeElement === host,
        open: panel?.classList.contains("lift-open"),
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const after = runtime.getRuntimeStats();
    return {
      focused: document.activeElement === host,
      open: Boolean(panel?.classList.contains("lift-open")),
      attributions: after.attributions - before.attributions,
      undos: after.undos - before.undos,
    };
  });
  expect(result.focused).toBe(true);
  expect(result.open).toBe(true);
  expect(result.attributions).toBeGreaterThanOrEqual(1);
  expect(result.undos).toBe(0);
  await expect(page.locator("#focus-keep")).toBeFocused();
  await pause(page, 1500);
});

test("04-per-node-attribution", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await openCheckoutWithHover(page);
  await pause(page);
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const checkout = document.getElementById("checkout") || document.body;
    const pageStyle = document.createElement("style");
    pageStyle.textContent = ".dark { background-color:#111; color:#fff }";
    document.head.append(pageStyle);
    const a = document.createElement("div");
    a.id = "node-a";
    a.className = "demo-target";
    a.textContent = "A";
    a.style.cssText = "padding:10px;background:#fff;color:#111;font:700 18px/1.3 system-ui";
    const dark = document.createElement("div");
    dark.className = "dark";
    dark.style.cssText = "padding:10px;margin-top:12px";
    const b = document.createElement("div");
    b.id = "node-b";
    b.className = "demo-target";
    b.textContent = "B";
    b.style.cssText = "background:#fff;color:#111;font:700 18px/1.3 system-ui";
    checkout.append(a, dark, b);
    const applied = runtime.applyPatchSpec({
      id: "per-node",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["demo-target"] },
              declarations: [{ property: "color", value: "#111" }],
            },
          ],
        },
      ],
    });
    a.style.color = "#eee";
    b.style.backgroundColor = "";
    b.style.color = "";
    dark.append(b);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const sheet = document.querySelector("[data-lift-css]") as HTMLStyleElement | null;
    const stats = (window as unknown as { LiftRuntime?: { getRuntimeStats: () => unknown } })
      .LiftRuntime?.getRuntimeStats();
    console.log(stats);
    console.log({
      disabled: Boolean(sheet?.disabled),
      a: getComputedStyle(a).color,
      b: getComputedStyle(b).color,
    });
    return { ok: applied.ok, disabled: Boolean(sheet?.disabled), a: getComputedStyle(a).color, b: getComputedStyle(b).color };
  });
  expect(result.ok).toBe(true);
  expect(result.disabled).toBe(true);
  await pause(page, 2000);
});

test("04-cssom-edit-detected", async ({ page }) => {
  test.setTimeout(20_000);
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await openCheckoutWithHover(page);
  await pause(page);
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const checkout = document.getElementById("checkout") || document.body;
    const probe = document.createElement("div");
    probe.className = "demo-target";
    probe.textContent = "Sample";
    probe.style.cssText = "padding:12px;background:#fff;font:700 20px/1.3 system-ui";
    checkout.append(probe);
    const applied = runtime.applyPatchSpec({
      id: "cssom-edit",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["demo-target"] },
              declarations: [{ property: "color", value: "#111" }],
            },
          ],
        },
      ],
    });
    const sheet = document.querySelector("[data-lift-css]") as HTMLStyleElement | null;
    const rule = sheet?.sheet?.cssRules?.[0] as CSSStyleRule | undefined;
    if (rule) rule.style.color = "#eee";
    console.log({ color: getComputedStyle(probe).color, disabled: Boolean(sheet?.disabled) });
    const started = Date.now();
    while (Date.now() - started < 5000) {
      console.log({
        color: getComputedStyle(probe).color,
        disabled: Boolean(sheet?.disabled),
        elapsedSec: (Date.now() - started) / 1000,
      });
      if (sheet?.disabled) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { ok: applied.ok, disabled: Boolean(sheet?.disabled) };
  });
  expect(result.ok).toBe(true);
  expect(result.disabled).toBe(true);
  await pause(page, 1500);
});

test("05-sticky-identity", async ({ page }) => {
  await page.goto("/checkout/");
  await page.waitForTimeout(1500);
  const flagsmithReady = await page.evaluate(() => {
    const variant = document.body.getAttribute("data-variant");
    return variant === "control" || variant === "treatment";
  });
  expect(flagsmithReady).toBe(true);
  const first = await paintIdentityReadout(page);
  await logEvidence(page, { cookie: first.cookie, variant: first.variant, status: first.status });
  expect(first.cookie).toMatch(/lift_vid=/);
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-variant", first.variant);
  const again = await paintIdentityReadout(page);
  await logEvidence(page, { cookie: again.cookie, variant: again.variant, status: again.status });
  expect(again.cookie).toBe(first.cookie);
  expect(again.variant).toBe(first.variant);
  await pause(page, 2000);
});
