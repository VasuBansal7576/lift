import type { Page } from "@playwright/test";
import type { BarrierId, Persona, Variant } from "../../shared/types.ts";
import { contrastRatio, parseCssColor } from "./contrast.ts";
import type { AttemptResult } from "./attempt.ts";
import { expectedBlockedForSite, runGenericPersona } from "./generic-personas.ts";
import { applyLowVisionZoom, CONTRAST_FLOOR } from "./vision.ts";

export type { AttemptResult };
export { applyLowVisionZoom, CONTRAST_FLOOR };

const CHECKOUT_TIMEOUT = 2500;

async function waitForConversion(page: Page): Promise<boolean> {
  try {
    await page.locator("#confirmation").waitFor({ state: "visible", timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

async function fillKnownFields(page: Page) {
  await page.locator("#email").fill("ada@northline.test");
  await page.locator("#card-name").fill("Ada Lovelace");
  await page.locator("#card-number").fill("4242424242424242");
  await page.locator("#card-exp").fill("12/28");
  await page.locator("#card-cvc").fill("123");
}

export async function runMouse(page: Page): Promise<AttemptResult> {
  const nav = page.locator(".hover-nav");
  await nav.hover();
  const checkout = page.locator("#checkout-link");
  const shop = page.locator("#shop-trigger");
  try {
    await checkout.waitFor({ state: "visible", timeout: 800 });
  } catch {
    if (await shop.evaluate((el) => el.tagName === "BUTTON").catch(() => false)) {
      await shop.click();
    }
  }
  if (!(await checkout.isVisible().catch(() => false))) {
    return {
      converted: false,
      blockedBy: ["hover_menu"],
      reason: "Checkout link never appeared on hover",
    };
  }
  await checkout.click();
  await page.locator("#checkout").waitFor({ state: "visible", timeout: CHECKOUT_TIMEOUT });
  await fillKnownFields(page);
  await page.locator("#terms").check();
  await page.locator("#place-order").click();
  const converted = await waitForConversion(page);
  return {
    converted,
    blockedBy: converted ? [] : ["div_button"],
    reason: converted ? "Mouse completed checkout" : "Place order click did not confirm",
  };
}

export async function runKeyboard(page: Page): Promise<AttemptResult> {
  await page.locator("body").click({ position: { x: 8, y: 8 } });
  let opened = false;
  for (let i = 0; i < 24; i += 1) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return { tag: "", text: "", role: "", name: "" };
      return {
        tag: el.tagName,
        text: (el.textContent ?? "").trim(),
        role: el.getAttribute("role") ?? "",
        name: el.getAttribute("aria-label") ?? "",
      };
    });
    const label = `${focused.text} ${focused.name}`.toLowerCase();
    if (label.includes("shop") && (focused.tag === "BUTTON" || focused.role === "button")) {
      await page.keyboard.press("Enter");
    }
    if (label.includes("checkout") || label.includes("view cart")) {
      await page.keyboard.press("Enter");
      opened = true;
      break;
    }
  }
  if (!opened) {
    return {
      converted: false,
      blockedBy: ["hover_menu"],
      reason: "Keyboard never reached a named Checkout control",
    };
  }
  try {
    await page.locator("#checkout").waitFor({ state: "visible", timeout: CHECKOUT_TIMEOUT });
  } catch {
    return {
      converted: false,
      blockedBy: ["hover_menu"],
      reason: "Checkout section stayed hidden",
    };
  }

  const order = ["#email", "#card-name", "#card-number", "#card-exp", "#card-cvc"];
  const values = [
    "ada@northline.test",
    "Ada Lovelace",
    "4242424242424242",
    "12/28",
    "123",
  ];
  for (let i = 0; i < order.length; i += 1) {
    await page.locator(order[i]).focus();
    await page.keyboard.type(values[i]);
  }
  await page.locator("#terms").focus();
  await page.keyboard.press("Space");

  let onPay = false;
  for (let i = 0; i < 16; i += 1) {
    await page.keyboard.press("Tab");
    const focusedId = await page.evaluate(() => document.activeElement?.id ?? "");
    if (focusedId === "place-order") {
      onPay = true;
      break;
    }
  }
  if (!onPay) {
    return {
      converted: false,
      blockedBy: ["div_button"],
      reason: "Place order is not in the tab order",
    };
  }
  await page.keyboard.press("Enter");
  const converted = await waitForConversion(page);
  return {
    converted,
    blockedBy: converted ? [] : ["div_button"],
    reason: converted
      ? "Keyboard completed checkout"
      : "Keyboard could not activate Place order",
  };
}

export async function runScreenReader(page: Page): Promise<AttemptResult> {
  const checkout = page.getByRole("link", { name: "Checkout" });
  const cart = page.getByRole("button", { name: "View cart and check out" });
  const shop = page.getByRole("button", { name: "Shop" });
  if (await shop.count()) {
    await shop.click();
  }
  if (await checkout.count()) {
    await checkout.click();
  } else if (await cart.count()) {
    await cart.click();
  } else {
    return {
      converted: false,
      blockedBy: ["hover_menu", "unlabeled_icon"],
      reason: "No named Checkout or cart control in the accessibility tree",
    };
  }
  try {
    await page.locator("#checkout").waitFor({ state: "visible", timeout: CHECKOUT_TIMEOUT });
  } catch {
    return {
      converted: false,
      blockedBy: ["hover_menu"],
      reason: "Named control did not reveal checkout",
    };
  }

  const email = page.getByRole("textbox", { name: "Email" });
  if (!(await email.count())) {
    return {
      converted: false,
      blockedBy: ["missing_labels"],
      reason: "Email field has no accessible name",
    };
  }
  await email.fill("ada@northline.test");
  await page.getByRole("textbox", { name: "Name on card" }).fill("Ada Lovelace");
  await page.getByRole("textbox", { name: "Card number" }).fill("4242424242424242");
  await page.getByRole("textbox", { name: "Expiry" }).fill("12/28");
  await page.getByRole("textbox", { name: "CVC" }).fill("123");
  const terms = page.getByRole("checkbox", { name: /terms of sale/i });
  if (!(await terms.count())) {
    return {
      converted: false,
      blockedBy: ["unlabeled_terms"],
      reason: "Terms checkbox has no accessible name",
    };
  }
  await terms.check();
  const place = page.getByRole("button", { name: "Place order" });
  if (!(await place.count())) {
    return {
      converted: false,
      blockedBy: ["div_button"],
      reason: "No button named Place order",
    };
  }
  await place.click();
  const converted = await waitForConversion(page);
  return {
    converted,
    blockedBy: converted ? [] : ["div_button"],
    reason: converted
      ? "Screen-reader persona completed checkout via roles and names"
      : "Named Place order did not confirm",
  };
}

export async function runLowVision(page: Page): Promise<AttemptResult> {
  await applyLowVisionZoom(page);
  const nav = page.locator(".hover-nav");
  await nav.hover();
  const checkout = page.locator("#checkout-link");
  if (await checkout.isVisible()) {
    await checkout.click();
  } else {
    await page.locator("#cart-icon").click();
  }
  try {
    await page.locator("#checkout").waitFor({ state: "visible", timeout: CHECKOUT_TIMEOUT });
  } catch {
    return {
      converted: false,
      blockedBy: ["hover_menu"],
      reason: "Could not open checkout at 200% zoom",
    };
  }

  const contrast = await page.locator("#terms-copy").evaluate(
    (el) => {
      const style = getComputedStyle(el);
      const parent = el.parentElement ? getComputedStyle(el.parentElement) : style;
      return { color: style.color, background: parent.backgroundColor };
    },
    undefined,
    { timeout: 4000 },
  );
  const bg = parseCssColor(contrast.background);
  const fg = parseCssColor(contrast.color, bg);
  const ratio = contrastRatio(fg, bg);
  if (ratio < CONTRAST_FLOOR) {
    return {
      converted: false,
      blockedBy: ["low_contrast"],
      reason: `Terms copy contrast ${ratio.toFixed(2)}:1 is below ${CONTRAST_FLOOR}:1 (contrast-threshold persona)`,
    };
  }

  await fillKnownFields(page);
  await page.locator("#terms").check();
  await page.locator("#place-order").click();
  const converted = await waitForConversion(page);
  return {
    converted,
    blockedBy: converted ? [] : ["low_contrast"],
    reason: converted
      ? "Contrast-threshold persona could read terms and complete checkout"
      : "Order did not confirm after readable terms",
  };
}

export async function runPersona(
  page: Page,
  persona: Persona,
): Promise<AttemptResult> {
  const site = await page.evaluate(() => document.body.dataset.site || "checkout");
  if (site !== "checkout") return runGenericPersona(page, persona);
  switch (persona) {
    case "mouse":
      return runMouse(page);
    case "keyboard":
      return runKeyboard(page);
    case "screen-reader":
      return runScreenReader(page);
    case "low-vision":
      return runLowVision(page);
    default: {
      const _exhaustive: never = persona;
      throw new Error(`Unhandled persona ${_exhaustive}`);
    }
  }
}

/** Exact blockedBy the bot returns on the control/treatment fixtures. */
export function expectedBlocked(
  persona: Persona,
  variant: Variant,
  siteId = "checkout",
): BarrierId[] {
  if (siteId !== "checkout") return expectedBlockedForSite(siteId, persona, variant);
  if (variant === "treatment") return [];
  switch (persona) {
    case "mouse":
      return [];
    case "keyboard":
      return ["hover_menu"];
    case "screen-reader":
      return ["hover_menu", "unlabeled_icon"];
    case "low-vision":
      return ["low_contrast"];
    default: {
      const _exhaustive: never = persona;
      throw new Error(`Unhandled persona ${_exhaustive}`);
    }
  }
}
