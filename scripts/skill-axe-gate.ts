import { AxeBuilder } from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import { parseArgs, flagString } from "../selfhost/src/args.ts";
import { compareAxeGate, type AxeViolationSummary } from "../selfhost/src/axe-gate.ts";
import { printJson } from "../selfhost/src/redact.ts";

async function scan(url: string): Promise<AxeViolationSummary[]> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    const results = await new AxeBuilder({ page }).include("body").analyze();
    return results.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.length,
      impact: v.impact ?? null,
    }));
  } finally {
    await context.close();
    await browser.close();
  }
}

const { flags } = parseArgs(process.argv.slice(2));
const controlUrl = flagString(flags, "control");
const variantUrl = flagString(flags, "variant");
if (!controlUrl || !variantUrl) {
  printJson({ ok: false, reason: "pass --control <url> --variant <url>" });
  process.exit(1);
}
const control = await scan(controlUrl);
const variant = await scan(variantUrl);
const gate = compareAxeGate(control, variant);
printJson({ ...gate, control, variant });
process.exit(gate.rejected ? 2 : 0);
