import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { AXE_GATE_RULES } from "../../shared/patch-spec.ts";
import { ROOT } from "../../agent/src/config.ts";
import {
  EDGE_ORIGIN,
  TREATMENT_ID,
  startEdgeStack,
  type EdgeStack,
} from "./edge-stack.ts";

const RECORD = process.env.LIFT_EDGE_RECORD === "1";
const OUT = resolve(ROOT, "recordings/edge");

test.describe.configure({ mode: "serial" });
test.skip(!RECORD, "set LIFT_EDGE_RECORD=1 to write recordings/edge/*.webm");

test.use({
  video: { mode: "on", size: { width: 1280, height: 800 } },
  viewport: { width: 1280, height: 800 },
  locale: "en-GB",
});

let stack: EdgeStack;

test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  stack = await startEdgeStack();
});

test.afterAll(async () => {
  await stack?.stop();
});

async function banner(page: Page, text: string) {
  await page.evaluate((message) => {
    let el = document.getElementById("lift-record-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "lift-record-banner";
      el.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:12px 16px;font:600 18px/1.4 system-ui;background:#111;color:#fff";
      document.body.prepend(el);
    }
    el.textContent = message;
  }, text);
  await page.waitForTimeout(1200);
}

async function axeLine(page: Page) {
  const results = await new AxeBuilder({ page }).include("body").analyze();
  const gate = results.violations.filter((v) =>
    (AXE_GATE_RULES as readonly string[]).includes(v.id),
  );
  return `axe ${results.violations.length} total, gate ${gate.length} (${gate.map((v) => v.id).join(", ") || "none"})`;
}

async function saveVideo(page: Page, name: string) {
  const video = page.video();
  await page.close();
  if (!video) return;
  const path = await video.path();
  copyFileSync(path, resolve(OUT, name));
}

test("edge-zero-code-fix", async ({ page, context }) => {
  await page.goto("http://127.0.0.1:4174/checkout/?lift_variant=control");
  await banner(page, "ORIGIN direct — barriers on. " + (await axeLine(page)));
  await page.locator(".hover-nav").hover();
  await page.locator("#checkout-link").click();
  await page.locator("#checkout").waitFor({ state: "visible" });
  await banner(page, "ORIGIN checkout open. " + (await axeLine(page)));
  await page.waitForTimeout(800);

  await context.addCookies([{ name: "lift_vid", value: TREATMENT_ID, url: EDGE_ORIGIN }]);
  await page.goto(`${EDGE_ORIGIN}/checkout/`);
  await page.waitForFunction(() => document.documentElement.dataset.liftApplied === "1", null, {
    timeout: 15_000,
  });
  await banner(page, "WORKER treatment — spec applied. " + (await axeLine(page)));
  await page.locator("#shop-trigger").click();
  await page.locator("#checkout-link").click();
  await page.locator("#checkout").waitFor({ state: "visible" });
  await banner(page, "WORKER checkout. " + (await axeLine(page)));
  await expect(page.locator('label[for="email"]')).toBeVisible();
  await saveVideo(page, "edge-zero-code-fix.webm");
});

test("edge-flag-flip", async ({ page, context }) => {
  await context.addCookies([{ name: "lift_vid", value: "lift-flip-user", url: EDGE_ORIGIN }]);
  stack.mock.assignments.set("lift-flip-user", null);
  await page.goto(`${EDGE_ORIGIN}/checkout/`);
  await page.waitForFunction(() => document.documentElement.dataset.liftEdge === "injected");
  await banner(page, "Flag = control (no spec). Shop is a span.");
  await expect(page.locator("#shop-trigger")).toHaveJSProperty("tagName", "SPAN");
  stack.mock.assignments.set("lift-flip-user", "checkout-treatment-v0");
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.liftApplied === "1", null, {
    timeout: 15_000,
  });
  await banner(page, "Flag flipped to treatment. Shop is a button.");
  await expect(page.locator("#shop-trigger")).toHaveRole("button");
  await saveVideo(page, "edge-flag-flip.webm");
});

test("edge-sticky", async ({ page, context }) => {
  await page.goto(`${EDGE_ORIGIN}/checkout/`);
  await page.waitForFunction(() => document.documentElement.dataset.liftEdge === "injected");
  const first = (await context.cookies()).find((c) => c.name === "lift_vid");
  expect(first?.value).toBeTruthy();
  await page.evaluate(() => {
    const pre = document.createElement("pre");
    pre.id = "lift-cookie-readout";
    pre.style.cssText =
      "position:fixed;bottom:0;left:0;right:0;z-index:2147483647;margin:0;padding:12px;background:#111;color:#9f9;font:16px/1.4 ui-monospace";
    pre.textContent = `document.cookie = ${document.cookie}`;
    document.body.appendChild(pre);
  });
  await banner(page, `sticky lift_vid=${first?.value}`);
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.liftEdge === "injected");
  const again = (await context.cookies()).find((c) => c.name === "lift_vid");
  expect(again?.value).toBe(first?.value);
  await page.evaluate(() => {
    const pre = document.getElementById("lift-cookie-readout") || document.createElement("pre");
    pre.id = "lift-cookie-readout";
    pre.style.cssText =
      "position:fixed;bottom:0;left:0;right:0;z-index:2147483647;margin:0;padding:12px;background:#111;color:#9f9;font:16px/1.4 ui-monospace";
    pre.textContent = `after reload: ${document.cookie}`;
    document.body.appendChild(pre);
  });
  await banner(page, `reload kept lift_vid=${again?.value}`);
  await saveVideo(page, "edge-sticky.webm");
});

test("edge-fail-open", async ({ page, context }) => {
  await context.addCookies([{ name: "lift_vid", value: TREATMENT_ID, url: EDGE_ORIGIN }]);
  await page.goto(`${EDGE_ORIGIN}/checkout/`);
  await page.waitForFunction(() => document.documentElement.dataset.liftApplied === "1");
  await banner(page, "Flagsmith up — treatment applied.");
  await stack.mock.server.close();
  await page.reload({ waitUntil: "domcontentloaded" });
  await banner(page, "Flagsmith stopped — origin page intact, no Lift scripts.");
  await expect(page.locator("#shop-trigger")).toHaveJSProperty("tagName", "SPAN");
  const html = await page.content();
  expect(html).not.toContain("lift-edge-config");
  await saveVideo(page, "edge-fail-open.webm");
});
