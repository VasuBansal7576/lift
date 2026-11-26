import { describe, expect, it } from "vitest";
import {
  decideExperiment,
  parseFlagsmithWin,
  summariseVisits,
} from "../../agent/src/decide.ts";
import type { VisitRecord } from "../../shared/types.ts";
import fixture from "../fixtures/flagsmith-results.json" with { type: "json" };

function visit(
  partial: Pick<VisitRecord, "identity" | "persona" | "variant" | "converted">,
): VisitRecord {
  return {
    blockedBy: [],
    reason: "fixture",
    simulated: true,
    ...partial,
  };
}

describe("summariseVisits", () => {
  it("counts conversions per arm", () => {
    const summary = summariseVisits([
      visit({ identity: "a", persona: "mouse", variant: "control", converted: true }),
      visit({ identity: "b", persona: "keyboard", variant: "control", converted: false }),
      visit({ identity: "c", persona: "mouse", variant: "treatment", converted: true }),
      visit({ identity: "d", persona: "keyboard", variant: "treatment", converted: true }),
    ]);
    expect(summary.control).toEqual({ visitors: 2, conversions: 1 });
    expect(summary.treatment).toEqual({ visitors: 2, conversions: 2 });
  });
});

describe("parseFlagsmithWin", () => {
  it("reads chance_to_win from the native results payload", () => {
    const parsed = parseFlagsmithWin({
      results: {
        as_of: "2026-11-26T00:00:00Z",
        payload: {
          metrics: [
            {
              inference: {
                treatment: { chance_to_win: 0.981, lift: 1.4 },
              },
            },
          ],
        },
      },
    });
    expect(parsed).toEqual({
      chanceToWin: 0.981,
      lift: 1.4,
      asOf: "2026-11-26T00:00:00Z",
    });
  });

  it("returns null when Flagsmith has not computed yet", () => {
    expect(parseFlagsmithWin({ results: null })).toBeNull();
  });

  it("falls back to the non-control inference arm when the key is not treatment", () => {
    const parsed = parseFlagsmithWin({
      results: {
        payload: {
          metrics: [
            {
              inference: {
                control: { chance_to_win: 0.1, lift: 0 },
                v_treatment: { chance_to_win: 0.9, lift: 2 },
              },
            },
          ],
        },
      },
    });
    expect(parsed?.chanceToWin).toBe(0.9);
  });
});

describe("decideExperiment", () => {
  const strongTreatment: VisitRecord[] = [
    ...Array.from({ length: 50 }, (_, i) =>
      visit({
        identity: `c${i}`,
        persona: "mouse",
        variant: "control",
        converted: i < 12,
      }),
    ),
    ...Array.from({ length: 50 }, (_, i) =>
      visit({
        identity: `t${i}`,
        persona: "keyboard",
        variant: "treatment",
        converted: true,
      }),
    ),
  ];

  it("uses Flagsmith chance_to_win from the saved results fixture", () => {
    const decision = decideExperiment({
      flag: "checkout_a11y",
      visits: strongTreatment,
      threshold: 0.95,
      flagsmith: fixture,
    });
    expect(decision.source).toBe("flagsmith");
    expect(decision.winProbabilityTreatment).toBe(
      fixture.results.payload.metrics[0].inference.treatment.chance_to_win,
    );
    expect(decision.decision).toBe("keep_running");
    expect(decision.notes.some((n) => n.includes("SIMULATED"))).toBe(true);
  });

  it("falls back to local Bayesian when Flagsmith is empty", () => {
    const decision = decideExperiment({
      flag: "checkout_a11y",
      visits: strongTreatment,
      threshold: 0.95,
      flagsmith: null,
    });
    expect(decision.source).toBe("local_bayesian");
    expect(decision.decision).toBe("rollout_treatment");
    expect(decision.winProbabilityTreatment).toBeGreaterThan(0.95);
  });

  it("pulls a loser", () => {
    const visits: VisitRecord[] = [
      ...Array.from({ length: 50 }, (_, i) =>
        visit({
          identity: `c${i}`,
          persona: "mouse",
          variant: "control",
          converted: true,
        }),
      ),
      ...Array.from({ length: 50 }, (_, i) =>
        visit({
          identity: `t${i}`,
          persona: "keyboard",
          variant: "treatment",
          converted: i < 5,
        }),
      ),
    ];
    const decision = decideExperiment({
      flag: "checkout_a11y",
      visits,
      threshold: 0.95,
    });
    expect(decision.decision).toBe("pull_to_control");
  });

  it("keeps running when the win probability is in the middle", () => {
    const visits: VisitRecord[] = [
      ...Array.from({ length: 50 }, (_, i) =>
        visit({
          identity: `c${i}`,
          persona: "mouse",
          variant: "control",
          converted: i < 25,
        }),
      ),
      ...Array.from({ length: 50 }, (_, i) =>
        visit({
          identity: `t${i}`,
          persona: "keyboard",
          variant: "treatment",
          converted: i < 26,
        }),
      ),
    ];
    const decision = decideExperiment({
      flag: "checkout_a11y",
      visits,
      threshold: 0.95,
      flagsmith: {
        results: {
          payload: {
            metrics: [{ inference: { treatment: { chance_to_win: 0.61, lift: 0.04 } } }],
          },
        },
      },
    });
    expect(decision.source).toBe("flagsmith");
    expect(decision.decision).toBe("keep_running");
  });
});
