import { describe, expect, it } from "vitest";
import { pickChampion } from "../../orchestrator/src/conductor.ts";
import { fullTreatmentSpec, labelsSpec } from "../../orchestrator/src/agents/mutator.ts";
import type { GenerationRecord, GateResult } from "../../orchestrator/src/types.ts";

function gate(specId: string, spec: GateResult["spec"], afterViolations: number, afterNodes: number): GateResult {
  const baseline = {
    url: "http://127.0.0.1:4174/checkout",
    violationCount: 4,
    nodeCount: 8,
    ruleIds: ["label", "button-name", "color-contrast"],
    violations: [],
  };
  return {
    specId,
    title: specId,
    kind: "template",
    spec,
    apply: { ok: true },
    baseline,
    after: { ...baseline, violationCount: afterViolations, nodeCount: afterNodes },
    passed: true,
    reason: "ok",
  };
}

describe("pickChampion", () => {
  it("uses the Flagsmith winner when chance_to_win cleared the threshold", () => {
    const full = fullTreatmentSpec("full-v1");
    const labels = labelsSpec();
    const generation = {
      generation: 1,
      passed: [gate("labels-v1", labels, 3, 3), gate("full-v1", full, 1, 1)],
      recommendation: {
        kind: "winner" as const,
        arm: "full-v1",
        chanceToWin: 0.98,
        threshold: 0.95,
        arms: [],
        source: "flagsmith" as const,
      },
    } as unknown as GenerationRecord;
    expect(pickChampion(generation)?.id).toBe("full-v1");
  });

  it("falls back to the gated spec with the fewest remaining axe hits", () => {
    const full = fullTreatmentSpec("full-v1");
    const labels = labelsSpec();
    const generation = {
      generation: 1,
      passed: [gate("labels-v1", labels, 3, 3), gate("full-v1", full, 1, 1)],
      recommendation: {
        kind: "keep_collecting" as const,
        threshold: 0.95,
        arms: [],
        source: "none" as const,
        reason: "Keep collecting.",
      },
    } as unknown as GenerationRecord;
    expect(pickChampion(generation)?.id).toBe("full-v1");
  });
});
