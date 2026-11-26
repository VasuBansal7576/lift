import { describe, expect, it } from "vitest";
import { buildResultsDocument } from "../../agent/src/dashboard.ts";
import { decideExperiment } from "../../agent/src/decide.ts";
import type { VisitRecord } from "../../shared/types.ts";
import { DEFAULT_PERSONA_MIX } from "../../shared/types.ts";
import fixture from "../fixtures/flagsmith-results-win.json" with { type: "json" };
import running from "../fixtures/flagsmith-results.json" with { type: "json" };

function visits(): VisitRecord[] {
  return [
    ...Array.from({ length: 50 }, (_, i) => ({
      identity: `c${i}`,
      persona: "mouse" as const,
      variant: "control" as const,
      converted: i < 12,
      blockedBy: [],
      reason: "fixture",
      simulated: true as const,
    })),
    ...Array.from({ length: 50 }, (_, i) => ({
      identity: `t${i}`,
      persona: "keyboard" as const,
      variant: "treatment" as const,
      converted: true,
      blockedBy: [],
      reason: "fixture",
      simulated: true as const,
    })),
  ];
}

describe("buildResultsDocument", () => {
  it("labels Flagsmith lift as simulated with the assumed mix", () => {
    const decision = decideExperiment({
      flag: "checkout_a11y",
      visits: visits(),
      threshold: 0.95,
      flagsmith: fixture,
    });
    const doc = buildResultsDocument({
      decision,
      visits: visits(),
      flagsmith: fixture,
      experimentId: 9,
      dashboardUrl: "https://app.flagsmith.com/project/56470/environment/120798/experiments/9",
      personaMix: DEFAULT_PERSONA_MIX,
    });
    expect(doc.headline.source).toBe("flagsmith");
    expect(doc.headline.copy).toMatch(
      /^Flagsmith lift \(SIMULATED traffic, assumed mix 70\/10\/10\/10\): /,
    );
    expect(doc.headline.copy).toMatch(/P\(win\) 99\.0%/);
    expect(doc.headline.copy).toMatch(/95% CI \+20\.0% to \+70\.0%/);
    expect(doc.headline.ciLow).toBe(0.2);
    expect(doc.headline.ciHigh).toBe(0.7);
    expect(doc.outcome).toMatch(/rolled out treatment/);
    expect(doc.personaMixNote).toContain("mouse 70%");
    expect(doc.personaMixNote).toContain("Win threshold is 95%");
    expect(doc.realisedMix.mouse).toBe(0.5);
    const experimentFlag = doc.flags.find((f) => f.role === "experiment");
    expect(experimentFlag && "armSource" in experimentFlag && experimentFlag.armSource).toBe(
      "flagsmith",
    );
    expect(doc.decision.notes.some((n) => n.includes("Local visit counts differ"))).toBe(true);
    expect(doc.decision.control.visitors).toBe(60);
    expect(doc.decision.treatment.visitors).toBe(60);
    expect(doc.localArms.control.visitors).toBe(50);
    expect(doc.localArms.treatment.visitors).toBe(50);
    expect(doc.personasNote).toBe("local visit log, n=100; Flagsmith counted n=120");
  });

  it("serialises infinite lift as Infinity, not null", () => {
    const noControl: VisitRecord[] = [
      {
        identity: "t0",
        persona: "mouse",
        variant: "treatment",
        converted: true,
        blockedBy: [],
        reason: "fixture",
        simulated: true,
      },
    ];
    const decision = decideExperiment({
      flag: "checkout_a11y",
      visits: noControl,
      threshold: 0.95,
      flagsmith: null,
    });
    const doc = buildResultsDocument({
      decision,
      visits: noControl,
      flagsmith: null,
      personaMix: DEFAULT_PERSONA_MIX,
    });
    expect(doc.headline.source).toBe("local_bayesian");
    expect(doc.headline.conversionLift).toBe("Infinity");
    expect(doc.decision.lift).toBe("Infinity");
    expect(doc.headline.copy).toMatch(/local_bayesian lift \(SIMULATED traffic/);
    expect(doc.outcome).toMatch(/Local Beta-Binomial math is inconclusive/);
  });

  it("says NOT significant when Flagsmith has not called a winner", () => {
    const decision = decideExperiment({
      flag: "checkout_a11y",
      visits: visits(),
      threshold: 0.95,
      flagsmith: running,
    });
    const doc = buildResultsDocument({
      decision,
      visits: visits(),
      flagsmith: running,
      personaMix: DEFAULT_PERSONA_MIX,
    });
    expect(decision.decision).toBe("keep_running");
    expect(doc.headline.copy).toMatch(/NOT significant/);
    expect(doc.headline.copy).toMatch(/keep running/);
    expect(doc.headline.copy).toMatch(/95% CI/);
    expect(doc.outcome).toMatch(/still running/);
  });
});
