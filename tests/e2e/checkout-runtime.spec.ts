import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { AXE_GATE_RULES } from "../../shared/patch-spec.ts";

async function openCheckout(page: Page) {
  await page.locator(".hover-nav").hover();
  await page.locator("#checkout-link").click();
  await page.locator("#checkout").waitFor({ state: "visible" });
}

test("checkout treatment spec via runtime.js clears the same axe gate as live treatment", async ({
  page,
}) => {
  await page.goto("/checkout/?lift_variant=control");
  await expect(page.locator("body")).toHaveAttribute("data-variant", "control");
  await expect(page.locator("#shop-trigger")).toHaveJSProperty("tagName", "SPAN");

  const applied = await page.evaluate(async () => {
    const runtimeHref = new URL("/runtime/runtime.js", location.origin).href;
    const specHref = new URL("/runtime/checkout-treatment.json", location.origin).href;
    const runtime = (await import(runtimeHref)) as {
      applyPatchSpec: (spec: unknown) => { ok: boolean; error?: string };
    };
    const spec = await fetch(specHref).then((res) => res.json());
    return runtime.applyPatchSpec(spec);
  });
  expect(applied).toEqual({ ok: true });

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
