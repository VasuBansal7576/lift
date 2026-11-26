import { expect, test, type Page } from "@playwright/test";
import { expectedBlocked, runPersona } from "../../traffic/src/personas.ts";
import type { Persona } from "../../shared/types.ts";

const personas: Persona[] = ["mouse", "keyboard", "screen-reader", "low-vision"];

async function open(page: Page, variant: "control" | "treatment") {
  await page.goto(`/?lift_variant=${variant}`);
  await expect(page.locator("body")).toHaveAttribute("data-variant", variant);
}

for (const persona of personas) {
  test(`${persona} is blocked by the control barriers`, async ({ page }) => {
    await open(page, "control");
    const result = await runPersona(page, persona);
    if (persona === "mouse") {
      expect(result.converted, result.reason).toBe(true);
      expect(result.blockedBy).toEqual([]);
    } else {
      expect(result.converted, result.reason).toBe(false);
      expect(result.blockedBy.length).toBeGreaterThan(0);
      const expected = expectedBlocked(persona, "control");
      expect(expected.some((id) => result.blockedBy.includes(id))).toBe(true);
    }
  });

  test(`${persona} converts when Flagsmith treatment is on`, async ({ page }) => {
    await open(page, "treatment");
    const result = await runPersona(page, persona);
    expect(result.converted, result.reason).toBe(true);
    await expect(page.locator("#confirmation")).toBeVisible();
  });
}
