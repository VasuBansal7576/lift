import type { Page } from "@playwright/test";
import type { BarrierId, Persona, Variant } from "../../shared/types.ts";
import { getSite } from "../../shared/catalog.ts";
import { contrastRatio, parseCssColor } from "./contrast.ts";
import type { AttemptResult } from "./attempt.ts";
import { applyLowVisionZoom, CONTRAST_FLOOR } from "./vision.ts";

const TIMEOUT = 2500;

const FIELD_VALUES: Record<string, string> = {
  email: "ada@northline.test",
  password: "correct-horse-battery",
  company: "Acme Labs",
  name: "Ada Lovelace",
  date: "2026-12-04",
  amount: "40",
  query: "waxed jacket",
  card: "4242424242424242",
};

async function waitForConversion(page: Page): Promise<boolean> {
  try {
    await page.locator("[data-lift-confirm]").waitFor({ state: "visible", timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

async function fillFields(page: Page) {
  const fields = page.locator("[data-lift-field]");
  const n = await fields.count();
  for (let i = 0; i < n; i += 1) {
    const field = fields.nth(i);
    const id = (await field.getAttribute("id")) ?? "";
    const type = (await field.getAttribute("type")) ?? "text";
    const value =
      FIELD_VALUES[id] ||
      (type === "email" ? FIELD_VALUES.email : undefined) ||
      (type === "password" ? FIELD_VALUES.password : undefined) ||
      (type === "date" ? FIELD_VALUES.date : undefined) ||
      (type === "number" ? FIELD_VALUES.amount : undefined) ||
      (type === "search" ? FIELD_VALUES.query : undefined) ||
      "Ada Lovelace";
    await field.fill(value);
  }
}

async function openIfNeeded(page: Page): Promise<boolean> {
  const panel = page.locator("#lift-panel");
  if ((await panel.count()) === 0) return true;
  if (await panel.isVisible().catch(() => false)) return true;
  const hasOpener =
    (await page.locator("[data-lift-open], .hover-nav").count()) > 0;
  if (!hasOpener) return true;
  const nav = page.locator(".hover-nav");
  if (await nav.count()) {
    await nav.hover();
  }
  const opener = page.locator("[data-lift-open]").first();
  if (await opener.count()) {
    try {
      await opener.waitFor({ state: "visible", timeout: 800 });
      await opener.click();
    } catch {
      const trigger = page.locator(".hover-trigger");
      if (await trigger.evaluate((el) => el.tagName === "BUTTON").catch(() => false)) {
        await trigger.click();
        if (await opener.isVisible().catch(() => false)) await opener.click();
      }
    }
  }
  if ((await panel.count()) === 0) return true;
  try {
    await panel.waitFor({ state: "visible", timeout: TIMEOUT });
    return true;
  } catch {
    return false;
  }
}

async function runSearch(page: Page) {
  const query = page.locator("[data-lift-query]");
  if ((await query.count()) === 0) return;
  await query.fill(FIELD_VALUES.query);
  const search = page.locator("[data-lift-search]");
  if (await search.count()) await search.click();
  const result = page.locator("[data-lift-result]");
  if (await result.count()) {
    await result.waitFor({ state: "visible", timeout: TIMEOUT });
  }
}

async function clickSubmit(page: Page) {
  const submit = page.locator("[data-lift-submit], [data-barrier='div_button']").first();
  await submit.click();
}

async function confirmFriction(page: Page) {
  const step = page.locator("[data-friction-step]");
  if ((await step.count()) === 0) return;
  if (await step.isVisible().catch(() => false)) {
    await page.locator("[data-lift-friction-confirm]").click();
  }
}

export async function runGenericMouse(page: Page): Promise<AttemptResult> {
  const opened = await openIfNeeded(page);
  if (!opened) {
    return {
      converted: false,
      blockedBy: ["hover_menu"],
      reason: "Entry control never appeared on hover",
    };
  }
  await runSearch(page);
  await fillFields(page);
  const terms = page.locator("[data-lift-terms]");
  if (await terms.count()) await terms.check();
  await clickSubmit(page);
  await confirmFriction(page);
  const converted = await waitForConversion(page);
  return {
    converted,
    blockedBy: converted ? [] : ["div_button"],
    reason: converted ? "Mouse completed the flow" : "Submit click did not confirm",
  };
}

export async function runGenericKeyboard(page: Page): Promise<AttemptResult> {
  await page.locator("body").click({ position: { x: 8, y: 8 } });
  const panel = page.locator("#lift-panel");
  const hasOpener =
    (await page.locator("[data-lift-open], .hover-nav").count()) > 0;
  const needsOpen =
    hasOpener &&
    (await panel.count()) > 0 &&
    !(await panel.isVisible().catch(() => false));
  if (needsOpen) {
    let opened = false;
    for (let i = 0; i < 24; i += 1) {
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return { tag: "", text: "", name: "" };
        return {
          tag: el.tagName,
          text: (el.textContent ?? "").trim(),
          name: el.getAttribute("aria-label") ?? "",
        };
      });
      const label = `${focused.text} ${focused.name}`.toLowerCase();
      if (
        focused.tag === "BUTTON" &&
        (label.includes("plan") ||
          label.includes("appointment") ||
          label.includes("shop") ||
          label.includes("bag") ||
          label.includes("menu"))
      ) {
        await page.keyboard.press("Enter");
      }
      const openerFocused = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return Boolean(el?.hasAttribute("data-lift-open"));
      });
      if (
        openerFocused ||
        label.includes("trial") ||
        label.includes("book") ||
        label.includes("visit") ||
        label.includes("cart") ||
        label.includes("give")
      ) {
        await page.keyboard.press("Enter");
        opened = true;
        break;
      }
    }
    if (!opened) {
      return {
        converted: false,
        blockedBy: ["hover_menu"],
        reason: "Keyboard never reached a named entry control",
      };
    }
    try {
      await panel.waitFor({ state: "visible", timeout: TIMEOUT });
    } catch {
      return {
        converted: false,
        blockedBy: ["hover_menu"],
        reason: "Entry panel stayed hidden",
      };
    }
  }

  const query = page.locator("[data-lift-query]");
  if (await query.count()) {
    await query.focus();
    await page.keyboard.type(FIELD_VALUES.query);
    let onSearch = false;
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press("Tab");
      const id = await page.evaluate(() => document.activeElement?.id ?? "");
      if (id === "search-btn") {
        onSearch = true;
        break;
      }
    }
    if (onSearch) await page.keyboard.press("Enter");
    const result = page.locator("[data-lift-result]");
    if (await result.count()) {
      try {
        await result.waitFor({ state: "visible", timeout: TIMEOUT });
      } catch {
        return {
          converted: false,
          blockedBy: ["unlabeled_icon"],
          reason: "Keyboard could not run search",
        };
      }
    }
  }

  const fields = page.locator("[data-lift-field]:not([data-lift-query])");
  const n = await fields.count();
  for (let i = 0; i < n; i += 1) {
    const field = fields.nth(i);
    await field.focus();
    const id = (await field.getAttribute("id")) ?? "";
    const type = (await field.getAttribute("type")) ?? "text";
    const value =
      FIELD_VALUES[id] ||
      (type === "email" ? FIELD_VALUES.email : undefined) ||
      (type === "password" ? FIELD_VALUES.password : undefined) ||
      (type === "date" ? FIELD_VALUES.date : undefined) ||
      (type === "number" ? FIELD_VALUES.amount : undefined) ||
      "Ada Lovelace";
    await page.keyboard.type(value);
  }
  const terms = page.locator("[data-lift-terms]");
  if (await terms.count()) {
    await terms.focus();
    await page.keyboard.press("Space");
  }

  let onPay = false;
  for (let i = 0; i < 16; i += 1) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return { id: "", tag: "" };
      return { id: el.id, tag: el.tagName };
    });
    if (
      focused.id === "place-order" ||
      focused.id === "subscribe" ||
      focused.id === "signin" ||
      focused.tag === "BUTTON"
    ) {
      onPay = focused.tag === "BUTTON";
      if (onPay) break;
    }
  }
  if (!onPay) {
    return {
      converted: false,
      blockedBy: ["div_button"],
      reason: "Submit is not in the tab order",
    };
  }
  await page.keyboard.press("Enter");
  const friction = page.locator("[data-friction-step]");
  if (await friction.isVisible().catch(() => false)) {
    await page.locator("[data-lift-friction-confirm]").focus();
    await page.keyboard.press("Enter");
  }
  const converted = await waitForConversion(page);
  return {
    converted,
    blockedBy: converted ? [] : ["div_button"],
    reason: converted
      ? "Keyboard completed the flow"
      : "Keyboard could not activate submit",
  };
}

export async function runGenericScreenReader(page: Page): Promise<AttemptResult> {
  const namedOpen = page.getByRole("link", {
    name: /start trial|book a visit|view cart|checkout/i,
  });
  const namedGive = page.getByRole("button", { name: /give to river keep|view cart/i });
  const namedShop = page.getByRole("button", {
    name: /plans|appointments|shop|bag/i,
  });
  if (await namedShop.count()) await namedShop.click();
  if (await namedOpen.count()) {
    await namedOpen.click();
  } else if (await namedGive.count()) {
    await namedGive.click();
  } else if ((await page.locator("[data-lift-open], .hover-nav").count()) > 0) {
    const hasHover = (await page.locator(".hover-nav").count()) > 0;
    return {
      converted: false,
      blockedBy: hasHover ? ["hover_menu"] : ["unlabeled_icon"],
      reason: "No named entry control in the accessibility tree",
    };
  }

  const searchBtn = page.getByRole("button", { name: /search the catalog/i });
  const query = page.getByRole("searchbox", { name: "Search" }).or(
    page.getByRole("textbox", { name: "Search" }),
  );
  if ((await page.locator("[data-lift-query]").count()) > 0) {
    if (!(await query.count())) {
      return {
        converted: false,
        blockedBy: ["missing_labels"],
        reason: "Search field has no accessible name",
      };
    }
    await query.fill(FIELD_VALUES.query);
    if (!(await searchBtn.count())) {
      return {
        converted: false,
        blockedBy: ["unlabeled_icon"],
        reason: "No named search control",
      };
    }
    await searchBtn.click();
  }

  const unlabeled = page.locator("[data-unlabeled]");
  if ((await unlabeled.count()) > 0 && (await page.locator("[data-lift-label]").count()) > 0) {
    const firstField = page.locator("[data-lift-field]").first();
    const id = await firstField.getAttribute("id");
    const name =
      (await firstField.getAttribute("data-lift-label")) ||
      (id === "email" ? "Email" : id === "company" ? "Workspace name" : "Email");
    const box = page.getByRole("textbox", { name }).or(page.getByRole("spinbutton", { name }));
    if (!(await box.count())) {
      return {
        converted: false,
        blockedBy: ["missing_labels"],
        reason: "Primary field has no accessible name",
      };
    }
  } else if ((await unlabeled.count()) > 0) {
    return {
      converted: false,
      blockedBy: ["missing_labels"],
      reason: "Primary field has no accessible name",
    };
  }

  await fillFields(page);

  const terms = page.getByRole("checkbox", { name: /terms|harbor notes/i });
  if ((await page.locator("[data-lift-terms]").count()) > 0) {
    if (!(await terms.count())) {
      return {
        converted: false,
        blockedBy: ["unlabeled_terms"],
        reason: "Terms checkbox has no accessible name",
      };
    }
    await terms.check();
  }

  const submit = page.locator("button[data-lift-submit], button#place-order, button.place-order");
  if (!(await submit.count())) {
    return {
      converted: false,
      blockedBy: ["div_button"],
      reason: "No named submit control",
    };
  }
  await submit.last().click();
  const friction = page.locator("[data-friction-step]");
  if (await friction.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: /start trial anyway/i }).click();
  }
  const converted = await waitForConversion(page);
  return {
    converted,
    blockedBy: converted ? [] : ["div_button"],
    reason: converted
      ? "Screen-reader persona completed the flow via roles and names"
      : "Named submit did not confirm",
  };
}

export async function runGenericLowVision(page: Page): Promise<AttemptResult> {
  await applyLowVisionZoom(page);
  const contrastEl = page.locator("[data-lift-contrast], #terms-copy");
  const opened = await openIfNeeded(page);
  if (!opened) {
    return {
      converted: false,
      blockedBy: ["hover_menu"],
      reason: "Could not open the flow at 200% zoom",
    };
  }
  await runSearch(page);
  if (await contrastEl.count()) {
    const contrast = await contrastEl.first().evaluate((el) => {
      const style = getComputedStyle(el);
      const parent = el.parentElement ? getComputedStyle(el.parentElement) : style;
      return { color: style.color, background: parent.backgroundColor };
    });
    const bg = parseCssColor(contrast.background);
    const fg = parseCssColor(contrast.color, bg);
    const ratio = contrastRatio(fg, bg);
    if (ratio < CONTRAST_FLOOR) {
      return {
        converted: false,
        blockedBy: ["low_contrast"],
        reason: `Copy contrast ${ratio.toFixed(2)}:1 is below ${CONTRAST_FLOOR}:1 (contrast-threshold persona)`,
      };
    }
  }
  await fillFields(page);
  const terms = page.locator("[data-lift-terms]");
  if (await terms.count()) await terms.check();
  await clickSubmit(page);
  await confirmFriction(page);
  const converted = await waitForConversion(page);
  return {
    converted,
    blockedBy: converted ? [] : ["low_contrast"],
    reason: converted
      ? "Contrast-threshold persona could read the copy and complete"
      : "Submit did not confirm after readable copy",
  };
}

export async function runGenericPersona(
  page: Page,
  persona: Persona,
): Promise<AttemptResult> {
  switch (persona) {
    case "mouse":
      return runGenericMouse(page);
    case "keyboard":
      return runGenericKeyboard(page);
    case "screen-reader":
      return runGenericScreenReader(page);
    case "low-vision":
      return runGenericLowVision(page);
    default: {
      const _exhaustive: never = persona;
      throw new Error(`Unhandled persona ${_exhaustive}`);
    }
  }
}

export function expectedBlockedForSite(
  siteId: string,
  persona: Persona,
  variant: Variant,
): BarrierId[] {
  if (variant === "treatment") return [];
  return [...getSite(siteId).controlBlocked[persona]];
}
