import { expect, test, type Page } from "@playwright/test";
import { SITES } from "../../shared/catalog.ts";
import { expectedBlocked, runPersona } from "../../traffic/src/personas.ts";
import type { Persona } from "../../shared/types.ts";

const NEW_SITES = SITES.filter((site) => site.id !== "checkout");

async function openSite(page: Page, siteId: string, variant: "control" | "treatment") {
  await page.goto(`/${siteId}/?lift_variant=${variant}`);
  await expect(page.locator("body")).toHaveAttribute("data-variant", variant);
  await expect(page.locator("#flag-status")).toHaveText("URL override (no Flagsmith)");
}

function personasThatMatter(siteId: string): Persona[] {
  const site = SITES.find((s) => s.id === siteId);
  if (!site) return [];
  const blocked = (Object.keys(site.controlBlocked) as Persona[]).filter(
    (persona) => site.controlBlocked[persona].length > 0,
  );
  if (!blocked.includes("mouse")) blocked.unshift("mouse");
  return blocked;
}

for (const site of NEW_SITES) {
  const personas = personasThatMatter(site.id);
  for (const persona of personas) {
    test(`${site.id} control: ${persona}`, async ({ page }) => {
      await openSite(page, site.id, "control");
      const result = await runPersona(page, persona);
      const expected = expectedBlocked(persona, "control", site.id);
      if (expected.length === 0) {
        expect(result.converted, result.reason).toBe(true);
      } else {
        expect(result.converted, result.reason).toBe(false);
      }
      expect(result.blockedBy, result.reason).toEqual(expected);
    });

    test(`${site.id} treatment: ${persona}`, async ({ page }) => {
      await openSite(page, site.id, "treatment");
      const result = await runPersona(page, persona);
      expect(result.converted, result.reason).toBe(true);
      expect(result.blockedBy).toEqual([]);
      await expect(page.locator("[data-lift-confirm]")).toBeVisible();
    });
  }
}
