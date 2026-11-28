import { AxeBuilder } from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import { parseArgs, flagString } from "../selfhost/src/args.ts";
import { printJson } from "../selfhost/src/redact.ts";
import type { AxeViolationSummary } from "../selfhost/src/axe-gate.ts";

async function scan(url: string): Promise<{ url: string; violations: AxeViolationSummary[]; count: number }> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    const results = await new AxeBuilder({ page }).include("body").analyze();
    const violations: AxeViolationSummary[] = results.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.length,
      impact: v.impact ?? null,
    }));
    return { url, violations, count: violations.length };
  } finally {
    await context.close();
    await browser.close();
  }
}

const { flags, rest } = parseArgs(process.argv.slice(2));
const url = flagString(flags, "url", rest[0] ?? "");
if (!url) {
  printJson({ ok: false, reason: "pass --url <page>" });
  process.exit(1);
}
const out = await scan(url);
printJson({ ok: true, ...out });
