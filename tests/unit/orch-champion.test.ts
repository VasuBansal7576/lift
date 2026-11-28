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

  it("returns null for a gen-1 control winner (unpatched page has no spec)", () => {
    const full = fullTreatmentSpec("full-v1");
    const generation = {
      generation: 1,
      passed: [gate("full-v1", full, 1, 1)],
      controlSpec: null,
      recommendation: {
        kind: "winner" as const,
        arm: "control",
        chanceToWin: 0.97,
        threshold: 0.95,
        arms: [],
        source: "flagsmith" as const,
      },
    } as unknown as GenerationRecord;
    expect(pickChampion(generation)).toBeNull();
  });

  it("returns the carried champion spec when gen-2 control wins", () => {
    const full = fullTreatmentSpec("full-v1");
    const generation = {
      generation: 2,
      passed: [gate("g2-focus", { ...full, id: "g2-focus" }, 1, 1)],
      controlSpec: full,
      flag: { controlKey: "control" },
      recommendation: {
        kind: "winner" as const,
        arm: "control",
        chanceToWin: 0.96,
        threshold: 0.95,
        arms: [],
        source: "flagsmith" as const,
      },
    } as unknown as GenerationRecord;
    expect(pickChampion(generation)?.id).toBe("full-v1");
  });

  it("returns a gen-2 challenger when that arm wins", () => {
    const full = fullTreatmentSpec("full-v1");
    const g2 = { ...full, id: "g2-focus" };
    const generation = {
      generation: 2,
      passed: [gate("g2-focus", g2, 1, 1)],
      controlSpec: full,
      recommendation: {
        kind: "winner" as const,
        arm: "g2-focus",
        chanceToWin: 0.96,
        threshold: 0.95,
        arms: [],
        source: "flagsmith" as const,
      },
    } as unknown as GenerationRecord;
    expect(pickChampion(generation)?.id).toBe("g2-focus");
  });

  it("does not fall back to fewest axe hits when Flagsmith has no winner", () => {
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
    expect(pickChampion(generation)).toBeNull();
  });
});
