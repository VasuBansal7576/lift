import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getSite, type SiteDef } from "../../shared/catalog.ts";
import { ROOT } from "./config.ts";

export interface ScanFinding {
  barrier: SiteDef["barriers"][number];
  evidence: string[];
}

export function scanSite(siteId = "checkout", htmlPath?: string) {
  const site = getSite(siteId);
  const path = htmlPath ?? resolve(ROOT, site.dir, "index.html");
  const html = readFileSync(path, "utf8");
  const findings: ScanFinding[] = [];

  for (const barrier of site.barriers) {
    const evidence: string[] = [];
    if (html.includes(`data-barrier="${barrier.id}"`)) {
      evidence.push(`${barrier.title} marked data-barrier=${barrier.id}`);
    }
    if (barrier.id === "autocomplete_off" && html.includes('autocomplete="off"')) {
      evidence.push("Control fields ship with autocomplete=off");
    }
    if (barrier.id === "extra_confirm" && html.includes("data-friction-step")) {
      evidence.push("Treatment friction step marked data-friction-step");
    }
    if (evidence.length > 0) {
      findings.push({ barrier, evidence });
    }
  }

  return {
    site: site.id,
    path,
    findings,
    missing: site.barriers.filter((b) => !findings.some((f) => f.barrier.id === b.id)),
  };
}

export function scanCheckoutSite(htmlPath = resolve(ROOT, "sites/checkout/index.html")) {
  return scanSite("checkout", htmlPath);
}

function main() {
  const siteId = process.env.LIFT_SITE || "checkout";
  const result = scanSite(siteId);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.findings.length < 3) {
    throw new Error(`Expected at least 3 WCAG barriers in the ${siteId} site`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
