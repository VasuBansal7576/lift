import { describe, expect, it } from "vitest";
import {
  armStats,
  bayesianWinProbability,
  clampLift,
  decideFromWinProbability,
  formatPWin,
  relativeLift,
  serialiseLift,
  srmPValue,
} from "../../agent/src/stats.ts";

describe("bayesianWinProbability", () => {
  it("is high when treatment converts much more", () => {
    const p = bayesianWinProbability(
      { conversions: 40, visitors: 50 },
      { conversions: 10, visitors: 50 },
    );
    expect(p).toBeGreaterThan(0.99);
  });

  it("is low when treatment converts much less", () => {
    const p = bayesianWinProbability(
      { conversions: 10, visitors: 50 },
      { conversions: 40, visitors: 50 },
    );
    expect(p).toBeLessThan(0.01);
  });

  it("is near a coin flip for equal arms", () => {
    const p = bayesianWinProbability(
      { conversions: 20, visitors: 40 },
      { conversions: 20, visitors: 40 },
    );
    expect(p).toBeGreaterThan(0.35);
    expect(p).toBeLessThan(0.65);
  });
});

describe("decideFromWinProbability", () => {
  it("rolls out a clear winner", () => {
    expect(decideFromWinProbability(0.97, 0.95)).toBe("rollout_treatment");
  });

  it("pulls a clear loser", () => {
    expect(decideFromWinProbability(0.02, 0.95)).toBe("pull_to_control");
  });

  it("keeps running when uncertain", () => {
    expect(decideFromWinProbability(0.7, 0.95)).toBe("keep_running");
  });
});

describe("formatPWin", () => {
  it("formats near-certain wins as >99.9%", () => {
    expect(formatPWin(0.999)).toBe(">99.9%");
    expect(formatPWin(1)).toBe(">99.9%");
    expect(formatPWin(0.99)).toBe("99.0%");
    expect(formatPWin(0.001)).toBe("<0.1%");
  });
});

describe("srmPValue", () => {
  it("is high for balanced 50/50 allocation", () => {
    expect(srmPValue(150, 150)).toBeGreaterThan(0.5);
  });

  it("rejects a 90/10 split at p < 0.01", () => {
    expect(srmPValue(270, 30)).toBeLessThan(0.01);
  });
});

describe("armStats / lift", () => {
  it("computes conversion rate", () => {
    expect(armStats(8, 32)).toEqual({ visitors: 32, conversions: 8, rate: 0.25 });
  });

  it("computes relative lift", () => {
    expect(relativeLift(0.5, 0.25)).toBe(1);
    expect(relativeLift(0.2, 0)).toBe(Infinity);
  });

  it("clamps Infinity for display", () => {
    expect(clampLift(Infinity)).toBe(10);
    expect(clampLift(-Infinity)).toBe(-10);
    expect(clampLift(0.43)).toBe(0.43);
    expect(clampLift(null)).toBeNull();
  });

  it("serialises Infinity instead of null", () => {
    expect(serialiseLift(Infinity)).toBe("Infinity");
    expect(serialiseLift(-Infinity)).toBe("-Infinity");
    expect(serialiseLift(0.34)).toBe(0.34);
    expect(serialiseLift(null)).toBeNull();
  });
});
