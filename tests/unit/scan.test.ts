import { describe, expect, it } from "vitest";
import { scanCheckoutSite } from "../../agent/src/scan.ts";

describe("scanCheckoutSite", () => {
  it("finds the five baked-in WCAG barriers", () => {
    const result = scanCheckoutSite();
    expect(result.findings.map((f) => f.barrier.id).sort()).toEqual([
      "div_button",
      "hover_menu",
      "low_contrast",
      "missing_labels",
      "unlabeled_icon",
    ]);
    expect(result.missing).toEqual([]);
  });
});
