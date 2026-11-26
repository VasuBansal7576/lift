import { expect, test, type Page } from "@playwright/test";
import { expectedBlocked, runPersona } from "../../traffic/src/personas.ts";
import type { Persona } from "../../shared/types.ts";

const personas: Persona[] = ["mouse", "keyboard", "screen-reader", "low-vision"];

async function openUrlOverride(page: Page, variant: "control" | "treatment") {
  await page.goto(`/checkout/?lift_variant=${variant}`);
  await expect(page.locator("body")).toHaveAttribute("data-variant", variant);
  await expect(page.locator("#flag-status")).toHaveText("URL override (no Flagsmith)");
}

for (const persona of personas) {
  test(`URL override: ${persona} is blocked by the control barriers`, async ({ page }) => {
    await openUrlOverride(page, "control");
    const result = await runPersona(page, persona);
    if (persona === "mouse") {
      expect(result.converted, result.reason).toBe(true);
    } else {
      expect(result.converted, result.reason).toBe(false);
    }
    expect(result.blockedBy, result.reason).toEqual(expectedBlocked(persona, "control"));
  });

  test(`URL override: ${persona} converts when treatment is on`, async ({ page }) => {
    await openUrlOverride(page, "treatment");
    const result = await runPersona(page, persona);
    expect(result.converted, result.reason).toBe(true);
    expect(result.blockedBy).toEqual([]);
    await expect(page.locator("#confirmation")).toBeVisible();
  });
}
