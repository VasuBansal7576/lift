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

async function openCheckout(page: Page) {
  await page.locator(".hover-nav").hover();
  await pause(page, 600);
  await page.locator("#checkout-link").click();
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

test("01-control-barriers", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await expect(page.locator("body")).toHaveAttribute("data-variant", "control");
  await showBanner(page, "CONTROL — hover to open Shop, unlabeled icon, unlabeled fields, low contrast, div Pay");
  await openCheckout(page);
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
  await openCheckout(page);
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
  await showBanner(
    page,
    `AFTER runtime.js spec — ${afterAxe.total} axe violations (was ${beforeAxe.total}); gate [${afterAxe.gate.join(", ") || "cleared"}]`,
  );
  for (const rule of AXE_GATE_RULES) {
    expect(afterAxe.gate, `treatment should not violate ${rule}`).not.toContain(rule);
  }
  expect(afterAxe.total).toBeLessThan(beforeAxe.total);
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
  await showBanner(page, "KEYBOARD — Tab to Shop, open checkout, fill, Tab to Place order, one Enter");
  await page.locator("#shop-trigger").focus();
  await page.keyboard.press("Enter");
  await page.locator("#checkout-link").focus();
  await page.keyboard.press("Enter");
  await page.locator("#checkout").waitFor({ state: "visible" });
  await fillCheckout(page);
  await page.locator("#terms").focus();
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

test("04-malicious-fail-open", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckout(page);
  const before = await page.evaluate(() => ({
    pay: document.getElementById("place-order")?.outerHTML ?? "",
    opacity: getComputedStyle(document.body).opacity,
    html: document.body.innerHTML.length,
  }));
  await showBanner(page, "FAIL-OPEN — applying CSS url-smuggle + :is(body){opacity:0}");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    return runtime.applyPatchSpec({
      id: "evil",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          css: 'h1{color:"/*"; background-image:url(http://x/leak) /* */}',
        },
        { op: "injectCSS", css: ":is(body){opacity:0}" },
      ],
    });
  });
  expect(result.ok).toBe(false);
  const after = await page.evaluate(() => ({
    pay: document.getElementById("place-order")?.outerHTML ?? "",
    opacity: getComputedStyle(document.body).opacity,
    html: document.body.innerHTML.length,
  }));
  expect(after.pay).toBe(before.pay);
  expect(after.opacity).toBe(before.opacity);
  await showBanner(
    page,
    `REJECTED (${result.error ?? "not allowlisted"}) — page unchanged, body opacity ${after.opacity}`,
  );
  await pause(page, 2000);
});

test("05-sticky-identity", async ({ page, context }) => {
  await page.goto("/checkout/?lift_variant=control");
  const first = (await context.cookies()).find((cookie) => cookie.name === "lift_vid");
  expect(first?.value).toBeTruthy();
  await showBanner(page, `IDENTITY first load lift_vid=${first?.value}`);
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-variant", "control");
  const again = (await context.cookies()).find((cookie) => cookie.name === "lift_vid");
  expect(again?.value).toBe(first?.value);
  await showBanner(page, `IDENTITY after reload lift_vid=${again?.value} (same cookie, Path=/)`);
  await pause(page, 2000);
});
