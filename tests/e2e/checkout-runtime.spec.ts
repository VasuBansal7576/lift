import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { AXE_GATE_RULES } from "../../shared/patch-spec.ts";

async function openCheckout(page: Page) {
  await page.locator(".hover-nav").hover();
  await page.locator("#checkout-link").click();
  await page.locator("#checkout").waitFor({ state: "visible" });
}

async function applyCheckoutSpec(page: Page) {
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
  await page.locator("#terms").check();
}

test("checkout treatment spec via runtime.js clears the same axe gate as live treatment", async ({
  page,
}) => {
  await page.goto("/checkout/?lift_variant=control");
  await expect(page.locator("body")).toHaveAttribute("data-variant", "control");
  await expect(page.locator("#shop-trigger")).toHaveJSProperty("tagName", "SPAN");

  const applied = await applyCheckoutSpec(page);
  expect(applied.ok).toBe(true);

  await expect(page.locator("#shop-trigger")).toHaveRole("button");
  await expect(page.locator("#cart-icon")).toHaveAttribute(
    "aria-label",
    "View cart and check out",
  );

  await openCheckout(page);
  await expect(page.locator('label[for="email"]')).toHaveText("Email");
  await expect(page.locator('label[for="terms"]')).toBeVisible();
  await expect(page.locator("#place-order")).toHaveRole("button");
  await expect(page.locator("#place-order")).toHaveText("Place order");
  const results = await new AxeBuilder({ page }).include("body").analyze();
  const ids = results.violations.map((v) => v.id);
  for (const rule of AXE_GATE_RULES) {
    expect(ids, `runtime spec should not violate ${rule} (got ${ids.join(", ")})`).not.toContain(
      rule,
    );
  }
});

test("checkout treatment spec keeps Place order click and Enter submitting", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await expect(page.locator("body")).toHaveAttribute("data-variant", "control");
  expect((await applyCheckoutSpec(page)).ok).toBe(true);
  await openCheckout(page);
  await fillCheckout(page);
  await page.locator("#place-order").click();
  await expect(page.locator("#confirmation")).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute("data-converted", "true");

  await page.goto("/checkout/?lift_variant=control");
  expect((await applyCheckoutSpec(page)).ok).toBe(true);
  await openCheckout(page);
  await fillCheckout(page);
  await page.locator("#place-order").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#confirmation")).toBeVisible();
});
