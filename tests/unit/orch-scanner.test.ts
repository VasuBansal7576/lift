import { describe, expect, it } from "vitest";
import { summariseAxe } from "../../orchestrator/src/browser.ts";

describe("scanner summariseAxe", () => {
  it("counts rules and nodes", () => {
    const summary = summariseAxe("http://127.0.0.1:4174/checkout", {
      violations: [
        {
          id: "label",
          impact: "critical",
          help: "Form elements must have labels",
          nodes: [{ target: ["#email"] }, { target: ["#card-name"] }],
        },
        {
          id: "button-name",
          impact: "critical",
          help: "Buttons must have discernible text",
          nodes: [{ target: ["#place-order"] }],
        },
      ],
    });
    expect(summary.violationCount).toBe(2);
    expect(summary.nodeCount).toBe(3);
    expect(summary.ruleIds).toEqual(["label", "button-name"]);
  });
});
