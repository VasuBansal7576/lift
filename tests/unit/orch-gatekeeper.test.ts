import { describe, expect, it } from "vitest";
import { evaluateGate } from "../../orchestrator/src/agents/gatekeeper.ts";
import type { AxeSummary } from "../../orchestrator/src/types.ts";

function axe(ruleIds: string[], nodeCount: number): AxeSummary {
  return {
    url: "http://127.0.0.1:4174/checkout",
    violationCount: ruleIds.length,
    nodeCount,
    ruleIds,
    violations: ruleIds.map((id) => ({
      id,
      impact: "serious",
      nodes: 1,
      targets: [[`#${id}`]],
      help: id,
    })),
  };
}

describe("gatekeeper evaluateGate", () => {
  const baseline = axe(["label", "button-name", "color-contrast"], 6);

  it("rejects runtime backstop failures", () => {
    const decision = evaluateGate({
      apply: { ok: false, error: "contrast below 4.5:1" },
      baseline,
      after: baseline,
    });
    expect(decision.passed).toBe(false);
    expect(decision.reason).toMatch(/runtime backstop/);
  });

  it("rejects variants that add axe rules", () => {
    const decision = evaluateGate({
      apply: { ok: true },
      baseline,
      after: axe(["label", "button-name", "color-contrast", "image-alt"], 7),
    });
    expect(decision.passed).toBe(false);
    expect(decision.reason).toMatch(/added axe rules/);
  });

  it("rejects variants that increase axe node counts", () => {
    const decision = evaluateGate({
      apply: { ok: true },
      baseline,
      after: axe(["label", "button-name", "color-contrast"], 9),
    });
    expect(decision.passed).toBe(false);
    expect(decision.reason).toMatch(/nodes increased/);
  });

  it("passes a variant that does not add violations", () => {
    const decision = evaluateGate({
      apply: { ok: true },
      baseline,
      after: axe(["label"], 2),
    });
    expect(decision.passed).toBe(true);
  });
});
