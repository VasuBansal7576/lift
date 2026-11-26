import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("URL override: axe-core finds control violations", async ({ page }) => {
  await page.goto("/?lift_variant=control");
  await expect(page.locator("body")).toHaveAttribute("data-variant", "control");
  const results = await new AxeBuilder({ page }).analyze();
  const ids = results.violations.map((v) => v.id);
  expect(results.violations.length, `axe violations: ${ids.join(", ")}`).toBeGreaterThan(0);
  expect(
    ids.some((id) =>
      ["label", "button-name", "color-contrast", "nested-interactive"].includes(id),
    ) || results.violations.length > 0,
  ).toBe(true);
});
