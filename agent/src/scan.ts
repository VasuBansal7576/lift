import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import barriersCatalog from "../../shared/barriers.json" with { type: "json" };
import type { Barrier } from "../../shared/types.ts";
import { ROOT } from "./config.ts";

export interface ScanFinding {
  barrier: Barrier;
  evidence: string[];
}

export function scanCheckoutSite(htmlPath = resolve(ROOT, "sites/checkout/index.html")) {
  const html = readFileSync(htmlPath, "utf8");
  const findings: ScanFinding[] = [];

  for (const barrier of barriersCatalog as Barrier[]) {
    const evidence: string[] = [];
    switch (barrier.id) {
      case "hover_menu":
        if (html.includes("data-barrier=\"hover_menu\"")) {
          evidence.push("Hover-only nav marked data-barrier=hover_menu");
        }
        if (html.includes("hover-menu") && html.includes("Checkout")) {
          evidence.push("Checkout is nested in a hover menu");
        }
        break;
      case "unlabeled_icon":
        if (html.includes("data-barrier=\"unlabeled_icon\"")) {
          evidence.push("Icon control marked data-barrier=unlabeled_icon");
        }
        break;
      case "div_button":
        if (html.includes("data-barrier=\"div_button\"")) {
          evidence.push("Place-order control is a non-button element");
        }
        if (/<div[^>]*id="place-order"/.test(html)) {
          evidence.push("div#place-order used instead of <button>");
        }
        break;
      case "missing_labels":
        if (html.includes("data-barrier=\"missing_labels\"")) {
          evidence.push("Checkout fields marked data-barrier=missing_labels");
        }
        if (!html.includes('for="email"') || html.includes("data-unlabeled")) {
          evidence.push("Email/card inputs ship without associated labels in control");
        }
        break;
      case "low_contrast":
        if (html.includes("data-barrier=\"low_contrast\"")) {
          evidence.push("Terms copy marked data-barrier=low_contrast");
        }
        if (html.includes("contrast-fail")) {
          evidence.push("contrast-fail class present for grey-on-grey terms");
        }
        break;
      default: {
        const _exhaustive: never = barrier.id;
        throw new Error(`Unhandled barrier: ${_exhaustive}`);
      }
    }
    if (evidence.length > 0) {
      findings.push({ barrier, evidence });
    }
  }

  return {
    site: "checkout",
    path: htmlPath,
    findings,
    missing: (barriersCatalog as Barrier[]).filter(
      (b) => !findings.some((f) => f.barrier.id === b.id),
    ),
  };
}

function main() {
  const result = scanCheckoutSite();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.findings.length < 3) {
    throw new Error("Expected at least 3 WCAG barriers in the checkout site");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
