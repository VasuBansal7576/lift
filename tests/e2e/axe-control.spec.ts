import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const CONTROL_RULES = ["label", "button-name", "color-contrast"] as const;

async function openCheckout(page: Page) {
  await page.locator(".hover-nav").hover();
  await page.locator("#checkout-link").click();
  await page.locator("#checkout").waitFor({ state: "visible" });
}

test("URL override: axe-core finds labelled control violations", async ({ page }) => {
  await page.goto("/?lift_variant=control");
  await expect(page.locator("body")).toHaveAttribute("data-variant", "control");
  await openCheckout(page);
  const results = await new AxeBuilder({ page }).include("body").analyze();
  const ids = results.violations.map((v) => v.id);
  for (const rule of CONTROL_RULES) {
    expect(ids, `control should violate ${rule} (got ${ids.join(", ")})`).toContain(rule);
  }
});

test("URL override: treatment clears those axe-core rules", async ({ page }) => {
  await page.goto("/?lift_variant=treatment");
  await expect(page.locator("body")).toHaveAttribute("data-variant", "treatment");
  await openCheckout(page);
  const results = await new AxeBuilder({ page }).include("body").analyze();
  const ids = results.violations.map((v) => v.id);
  for (const rule of CONTROL_RULES) {
    expect(ids, `treatment should not violate ${rule} (got ${ids.join(", ")})`).not.toContain(
      rule,
    );
  }
});
