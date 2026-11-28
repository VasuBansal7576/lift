import { describe, expect, it } from "vitest";
import { DEFAULT_PERSONA_MIX } from "../../shared/types.ts";
import {
  a11yOutcomeFromMeasurements,
  conversionProbability,
  expectedConversionRate,
  sendSimulatedConversions,
  simulatedConversionsLabel,
  SKILL_TRAFFIC_MIX,
  type A11yOutcome,
} from "../../selfhost/src/skill-traffic.ts";

const blocked: A11yOutcome = {
  hoverMenuBarrier: true,
  missingLabels: true,
  divButton: true,
  unlabeledIcon: true,
  lowContrast: true,
  axeKeyboardBarriers: true,
};

const fixed: A11yOutcome = {
  hoverMenuBarrier: false,
  missingLabels: false,
  divButton: false,
  unlabeledIcon: false,
  lowContrast: false,
  axeKeyboardBarriers: false,
};

describe("simulated conversion rates", () => {
  it("gives control and treatment the same expected rate when a11y outcomes match", () => {
    const control = expectedConversionRate(DEFAULT_PERSONA_MIX, blocked);
    const treatment = expectedConversionRate(DEFAULT_PERSONA_MIX, { ...blocked });
    expect(control).toBe(treatment);
    expect(expectedConversionRate(DEFAULT_PERSONA_MIX, fixed)).toBe(
      expectedConversionRate(DEFAULT_PERSONA_MIX, { ...fixed }),
    );
    expect(expectedConversionRate(SKILL_TRAFFIC_MIX, blocked)).toBe(
      expectedConversionRate(SKILL_TRAFFIC_MIX, { ...blocked }),
    );
  });

  it("does not take the variant name as an input — only the measured outcome", () => {
    expect(conversionProbability("keyboard", blocked)).toBe(0);
    expect(conversionProbability("screen-reader", blocked)).toBe(0);
    expect(conversionProbability("keyboard", fixed)).toBe(conversionProbability("mouse", fixed));
    expect(conversionProbability("mouse", blocked)).toBe(conversionProbability("mouse", fixed));
  });

  it("raises the expected rate when keyboard barriers are absent", () => {
    expect(expectedConversionRate(DEFAULT_PERSONA_MIX, fixed)).toBeGreaterThan(
      expectedConversionRate(DEFAULT_PERSONA_MIX, blocked),
    );
  });

  it("maps served-page measurements without using a variant label", () => {
    const control = a11yOutcomeFromMeasurements({
      shopIsButton: false,
      fieldsLabeled: false,
      placeOrderIsButton: false,
      contrastFixed: false,
      cartLabeled: false,
      axeIds: ["label", "button-name"],
    });
    const treatment = a11yOutcomeFromMeasurements({
      shopIsButton: false,
      fieldsLabeled: false,
      placeOrderIsButton: false,
      contrastFixed: false,
      cartLabeled: false,
      axeIds: ["label", "button-name"],
    });
    expect(control).toEqual(treatment);
    expect(expectedConversionRate(DEFAULT_PERSONA_MIX, control)).toBe(
      expectedConversionRate(DEFAULT_PERSONA_MIX, treatment),
    );
  });

  it("labels traffic as SIMULATED without hardcoded 85/15 rates", () => {
    expect(simulatedConversionsLabel(120)).toBe("SIMULATED conversions: 120 real Flagsmith identities");
    expect(simulatedConversionsLabel(200)).not.toMatch(/85%|15%/);
  });
});

describe("sendSimulatedConversions with a fake Flagsmith", () => {
  const base = {
    apiUrl: "http://127.0.0.1:9/api/v1/",
    eventsUrl: "http://127.0.0.1:9/api/",
    environmentKey: "env-key",
    flagName: "lift_a11y_r5",
    event: "checkout_completed",
    n: 80,
    runId: "fixed-run",
    seed: 1,
    hooks: {
      enroll: async () => undefined,
      getVariant: async (identity: string) => {
        const n = Number(identity.split("-").pop());
        return n % 2 === 0 ? ("control" as const) : ("treatment" as const);
      },
    },
  };

  it("prints the passed runId and equal outcomes give equal rates", async () => {
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const counts = await sendSimulatedConversions({
        ...base,
        outcomes: { control: fixed, treatment: { ...fixed } },
      });
      expect(lines.join("")).toContain("runId=fixed-run");
      expect(counts.control.n).toBe(counts.treatment.n);
      const controlRate = counts.control.conversions / counts.control.n;
      const treatmentRate = counts.treatment.conversions / counts.treatment.n;
      expect(Math.abs(controlRate - treatmentRate)).toBeLessThan(0.2);
    } finally {
      process.stderr.write = write;
    }
  });

  it("swapping outcomes flips the winner", async () => {
    const treatmentWins = await sendSimulatedConversions({
      ...base,
      outcomes: { control: blocked, treatment: fixed },
    });
    const controlWins = await sendSimulatedConversions({
      ...base,
      outcomes: { control: fixed, treatment: blocked },
    });
    const tRate = treatmentWins.treatment.conversions / treatmentWins.treatment.n;
    const tControl = treatmentWins.control.conversions / treatmentWins.control.n;
    const cRate = controlWins.control.conversions / controlWins.control.n;
    const cTreat = controlWins.treatment.conversions / controlWins.treatment.n;
    expect(tRate).toBeGreaterThan(tControl);
    expect(cRate).toBeGreaterThan(cTreat);
  });
});
