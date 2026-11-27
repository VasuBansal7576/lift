import type { Browser } from "@playwright/test";
import { gotoControl, launchBrowser, openCheckout, runAxe } from "../browser.ts";
import type { EventLog } from "../log.ts";
import type { ScanResult } from "../types.ts";

export async function runScanner(
  siteUrl: string,
  log: EventLog,
  browser?: Browser,
): Promise<ScanResult> {
  log.emit("scanner", "start", `axe-core on ${siteUrl}`);
  const owned = browser ?? (await launchBrowser());
  try {
    const context = await owned.newContext();
    const page = await context.newPage();
    await gotoControl(page, siteUrl);
    await openCheckout(page);
    const axe = await runAxe(page);
    await context.close();
    log.emit("scanner", "done", `${axe.violationCount} rules / ${axe.nodeCount} nodes`, {
      ruleIds: axe.ruleIds,
      nodeCount: axe.nodeCount,
    });
    return { url: axe.url, axe };
  } finally {
    if (!browser) await owned.close();
  }
}
