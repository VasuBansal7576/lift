import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../../agent/src/config.ts";
import { AXE_GATE_RULES } from "../../shared/patch-spec.ts";
import {
  CONTROL_ID,
  EDGE_ORIGIN,
  EDGE_PORT,
  SPEC_ID,
  TREATMENT_ID,
  assertLiveDevVarsUnchanged,
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

async function waitEdgeOrigin(page: Page) {
  await expect(page.locator("#flag-status")).toHaveText(/Edge origin/, { timeout: 15_000 });
  await expect(page.locator("#flag-status")).not.toHaveClass(/flagsmith-error/);
}

async function fillCheckout(page: Page) {
  await page.locator("#email").fill("ada@northline.test");
  await page.locator("#card-name").fill("Ada Lovelace");
  await page.locator("#card-number").fill("4242424242424242");
  await page.locator("#card-exp").fill("12/28");
  await page.locator("#card-cvc").fill("123");
  await page.locator("#terms").check();
}

async function mouseOpenCheckout(page: Page) {
  await page.locator(".hover-nav").hover();
  await page.locator("#checkout-link").click();
  await page.locator("#checkout").waitFor({ state: "visible" });
}

test("e2e stack does not overwrite edge/.dev.vars", () => {
  assertLiveDevVarsUnchanged(stack.liveDevVars);
});

test("control visitor sees the original barriers and no in-page experiment", async ({ page }) => {
  await openAs(page, CONTROL_ID);
  await waitInjected(page);
  await waitEdgeOrigin(page);
  await expect(page.locator("#shop-trigger")).toHaveJSProperty("tagName", "SPAN");
  await expect(page.locator("#shop-trigger")).not.toHaveAttribute("role", "button");
  await mouseOpenCheckout(page);
  await expect(page.locator('label[for="email"]')).toHaveCount(0);
  const html = await page.content();
  expect(html).toContain('"evaluated":true');
  expect(html).not.toContain("checkout_a11y");
  const results = await new AxeBuilder({ page }).include("body").analyze();
  const ids = results.violations.map((v) => v.id);
  for (const rule of AXE_GATE_RULES) {
    expect(ids, `control should violate ${rule}`).toContain(rule);
  }
});

test("control visitor completes checkout with the mouse", async ({ page }) => {
  await openAs(page, CONTROL_ID);
  await waitInjected(page);
  await waitEdgeOrigin(page);
  await mouseOpenCheckout(page);
  await fillCheckout(page);
  await page.locator("#place-order").click();
  await expect(page.locator("#confirmation")).toBeVisible();
});

test("treatment visitor gets the spec applied and axe gate drops", async ({ page }) => {
  await openAs(page, TREATMENT_ID);
  await waitApplied(page);
  await waitEdgeOrigin(page);
  await expect(page.locator("#shop-trigger")).toHaveRole("button");
  await expect(page.locator("#cart-icon")).toHaveAttribute(
    "aria-label",
    "View cart and check out",
  );
  await page.locator("#shop-trigger").click();
  await page.locator("#checkout-link").click();
  await page.locator("#checkout").waitFor({ state: "visible" });
  await expect(page.locator('label[for="email"]')).toHaveText("Email");
  await expect(page.locator("#place-order")).toHaveRole("button");
  await expect(page.locator("#place-order")).toHaveText("Place order");
  const html = await page.content();
  expect(html).toContain(SPEC_ID);
  expect(html).toContain("/__lift/runtime/runtime.js");
  const results = await new AxeBuilder({ page }).include("body").analyze();
  const ids = results.violations.map((v) => v.id);
  for (const rule of AXE_GATE_RULES) {
    expect(ids, `treatment should not violate ${rule} (got ${ids.join(", ")})`).not.toContain(
      rule,
    );
  }
});

test("treatment visitor completes checkout with the mouse", async ({ page }) => {
  await openAs(page, TREATMENT_ID);
  await waitApplied(page);
  await page.locator("#shop-trigger").click();
  await page.locator("#checkout-link").click();
  await page.locator("#checkout").waitFor({ state: "visible" });
  await fillCheckout(page);
  await page.locator("#place-order").click();
  await expect(page.locator("#confirmation")).toBeVisible();
});

test("treatment visitor completes checkout with the keyboard", async ({ page }) => {
  await openAs(page, TREATMENT_ID);
  await waitApplied(page);
  await expect(page).toHaveURL(/\/checkout\/$/);
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

test("control keyboard still cannot operate Shop (barriers hold)", async ({ page }) => {
  await openAs(page, CONTROL_ID);
  await waitInjected(page);
  await page.locator("body").click({ position: { x: 8, y: 8 } });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.locator("#shop-trigger")).not.toBeFocused();
  await expect(page.locator("#confirmation")).toBeHidden();
});

test("SSRF path variants return 400 through the Worker", async () => {
  const variants = [
    `http://127.0.0.1:${EDGE_PORT}//evil.example/`,
    `http://127.0.0.1:${EDGE_PORT}///evil.example/`,
    `http://127.0.0.1:${EDGE_PORT}/\\evil.example/`,
    `http://127.0.0.1:${EDGE_PORT}/%2F%2Fevil.example/`,
  ];
  for (const url of variants) {
    const res = await fetch(url, { redirect: "manual" });
    expect(res.status, url).toBe(400);
  }
});

test("HEAD does not set lift_vid or inject Lift", async () => {
  const res = await fetch(`${EDGE_ORIGIN}/checkout/`, { method: "HEAD" });
  expect(res.status).toBe(200);
  expect(res.headers.get("set-cookie")).toBeNull();
  const get = await fetch(`${EDGE_ORIGIN}/checkout/`, {
    method: "GET",
    headers: {
      cookie: "lift_vid=lift-e2e-control",
      Accept: "text/html",
      "Sec-Fetch-Dest": "document",
    },
  });
  const body = await get.text();
  expect(body).toContain("lift-edge-config");
});

test("Flagsmith down serves the origin page intact", async ({ page }) => {
  await stack.mock.server.close();
  await page.context().addCookies([{ name: "lift_vid", value: TREATMENT_ID, url: EDGE_ORIGIN }]);
  const nav = await page.goto(`${EDGE_ORIGIN}/checkout/`);
  await waitEdgeOrigin(page);
  await expect(page.locator("#shop-trigger")).toHaveJSProperty("tagName", "SPAN");
  const html = await page.content();
  expect(html).not.toContain("lift-edge-config");
  await expect(page.locator("#shop-trigger")).not.toHaveAttribute("role", "button");
  const timing = nav?.headers()["server-timing"] || "";
  expect(timing).toMatch(/flagsmith-down|flagsmith-timeout/);
  await mouseOpenCheckout(page);
  await fillCheckout(page);
  await page.locator("#place-order").click();
  await expect(page.locator("#confirmation")).toBeVisible();
});

test("origin HTML files are not modified", async () => {
  const src = readFileSync(resolve(ROOT, "sites/checkout/index.html"), "utf8");
  expect(src).not.toContain("lift-edge-config");
  expect(src).not.toContain("/__lift/bootstrap.js");
  expect(src).toContain('id="shop-trigger"');
});
