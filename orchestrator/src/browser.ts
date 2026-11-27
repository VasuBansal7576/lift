import { AxeBuilder } from "@axe-core/playwright";
import { chromium, type Browser, type Page } from "@playwright/test";
import type { PatchSpec } from "../../shared/patch-spec.ts";
import type { ApplyResult, AxeSummary, AxeViolationSummary } from "./types.ts";

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

export async function openCheckout(page: Page): Promise<void> {
  const checkout = page.locator("#checkout");
  if (await checkout.isVisible().catch(() => false)) return;
  await page.locator(".hover-nav").hover();
  const link = page.locator("#checkout-link");
  try {
    await link.waitFor({ state: "visible", timeout: 1200 });
    await link.click();
  } catch {
    await page.evaluate(() => {
      const section = document.getElementById("checkout");
      if (section) section.hidden = false;
    });
  }
  await checkout.waitFor({ state: "visible", timeout: 4000 });
}

export function summariseAxe(
  url: string,
  results: {
    violations: Array<{
      id: string;
      impact?: string | null;
      help?: string;
      nodes: Array<{ target?: unknown; html?: string }>;
    }>;
  },
): AxeSummary {
  const violations: AxeViolationSummary[] = results.violations.map((item) => ({
    id: item.id,
    impact: item.impact ?? null,
    nodes: item.nodes.length,
    targets: item.nodes.map((node) => {
      const target = node.target;
      return Array.isArray(target) ? target.map(String) : [];
    }),
    help: item.help ?? item.id,
  }));
  return {
    url,
    violationCount: violations.length,
    nodeCount: violations.reduce((sum, item) => sum + item.nodes, 0),
    ruleIds: violations.map((item) => item.id),
    violations,
  };
}

export async function runAxe(page: Page): Promise<AxeSummary> {
  const results = await new AxeBuilder({ page }).include("body").analyze();
  return summariseAxe(page.url(), results);
}

export async function applySpecOnPage(page: Page, spec: PatchSpec): Promise<ApplyResult> {
  return page.evaluate(async (payload) => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    const result = runtime.applyPatchSpec(payload);
    return { ok: result.ok, error: result.ok ? undefined : result.error };
  }, spec);
}

export async function gotoControl(page: Page, siteUrl: string): Promise<void> {
  const url = siteUrl.includes("?")
    ? `${siteUrl}${siteUrl.endsWith("&") ? "" : "&"}lift_variant=control`
    : `${siteUrl}/?lift_variant=control`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
}
