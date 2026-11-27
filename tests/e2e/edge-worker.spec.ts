import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../../agent/src/config.ts";
import { AXE_GATE_RULES } from "../../shared/patch-spec.ts";
import {
  CONTROL_ID,
  EDGE_ORIGIN,
  SPEC_ID,
  TREATMENT_ID,
  startEdgeStack,
  type EdgeStack,
} from "./edge-stack.ts";

test.describe.configure({ mode: "serial" });

let stack: EdgeStack;

test.beforeAll(async () => {
  stack = await startEdgeStack();
});

test.afterAll(async () => {
  await stack?.stop();
});

async function openAs(page: Page, visitorId: string, path = "/checkout/") {
  await page.context().addCookies([
    { name: "lift_vid", value: visitorId, url: EDGE_ORIGIN },
  ]);
  await page.goto(`${EDGE_ORIGIN}${path}`);
}

async function waitInjected(page: Page) {
  await page.waitForFunction(
    () => document.documentElement.dataset.liftEdge === "injected",
    null,
    { timeout: 15_000 },
  );
}

async function waitApplied(page: Page) {
  await page.waitForFunction(
    () => document.documentElement.dataset.liftApplied === "1",
    null,
    { timeout: 15_000 },
  );
}

async function openCheckout(page: Page) {
  const trigger = page.locator("#shop-trigger");
  await trigger.click();
  await page.locator("#checkout-link").click();
  await page.locator("#checkout").waitFor({ state: "visible" });
}

async function fillCheckout(page: Page) {
  await page.locator("#email").fill("ada@northline.test");
  await page.locator("#card-name").fill("Ada Lovelace");
  await page.locator("#card-number").fill("4242424242424242");
  await page.locator("#card-exp").fill("12/28");
  await page.locator("#card-cvc").fill("123");
  await page.locator("#terms").check();
}

test("control visitor sees the original barriers", async ({ page }) => {
  await openAs(page, CONTROL_ID);
  await waitInjected(page);
  await expect(page.locator("#shop-trigger")).toHaveJSProperty("tagName", "SPAN");
  await expect(page.locator("#shop-trigger")).not.toHaveAttribute("role", "button");
  await page.locator(".hover-nav").hover();
  await page.locator("#checkout-link").click();
  await page.locator("#checkout").waitFor({ state: "visible" });
  await expect(page.locator('label[for="email"]')).toHaveCount(0);
  const results = await new AxeBuilder({ page }).include("body").analyze();
  const ids = results.violations.map((v) => v.id);
  for (const rule of AXE_GATE_RULES) {
    expect(ids, `control should violate ${rule}`).toContain(rule);
  }
});

test("treatment visitor gets the spec applied and axe gate drops", async ({ page }) => {
  await openAs(page, TREATMENT_ID);
  await waitApplied(page);
  await expect(page.locator("#shop-trigger")).toHaveRole("button");
  await expect(page.locator("#cart-icon")).toHaveAttribute(
    "aria-label",
    "View cart and check out",
  );
  await openCheckout(page);
  await expect(page.locator('label[for="email"]')).toHaveText("Email");
  await expect(page.locator("#place-order")).toHaveRole("button");
  await expect(page.locator("#place-order")).toHaveText("Place order");
  const html = await page.content();
  expect(html).toContain(SPEC_ID);
  const results = await new AxeBuilder({ page }).include("body").analyze();
  const ids = results.violations.map((v) => v.id);
  for (const rule of AXE_GATE_RULES) {
    expect(ids, `treatment should not violate ${rule} (got ${ids.join(", ")})`).not.toContain(
      rule,
    );
  }
});

test("keyboard checkout works for a treatment visitor", async ({ page }) => {
  // Origin app.js binds the original click handler only after applyFixes.
  // Playwright's site server uses --allow-mock, so ?lift_variant=control
  // keeps origin barriers and handlers while the Worker still applies the spec.
  await openAs(page, TREATMENT_ID, "/checkout/?lift_variant=control");
  await waitApplied(page);
  await page.locator("body").click({ position: { x: 8, y: 8 } });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.locator("#shop-trigger")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#shop-menu")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator("#checkout-link")).toBeFocused();
  await page.keyboard.press("Enter");
  await page.locator("#checkout").waitFor({ state: "visible" });
  await fillCheckout(page);
  await page.locator("#place-order").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#confirmation")).toBeVisible();
});

test("Flagsmith down serves the origin page intact", async ({ page }) => {
  await stack.mock.server.close();
  await openAs(page, TREATMENT_ID);
  await expect(page.locator("#shop-trigger")).toHaveJSProperty("tagName", "SPAN");
  const html = await page.content();
  expect(html).not.toContain("lift-edge-config");
  await expect(page.locator("#shop-trigger")).not.toHaveAttribute("role", "button");
  const timing = await page.evaluate(async () => {
    const res = await fetch(location.href, { cache: "no-store" });
    return res.headers.get("server-timing") || "";
  });
  expect(timing).toMatch(/flagsmith-down|flagsmith-timeout/);
});

test("origin HTML files are not modified", async () => {
  const src = readFileSync(resolve(ROOT, "sites/checkout/index.html"), "utf8");
  expect(src).not.toContain("lift-edge-config");
  expect(src).not.toContain("/__lift/bootstrap.js");
  expect(src).toContain('id="shop-trigger"');
});
