import type { ArmStats } from "../../shared/types.ts";

function gammaSample(shape: number): number {
  if (shape < 1) {
    return gammaSample(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normalSample();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function normalSample(): number {
  const u = 1 - Math.random();
  const v = 1 - Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function betaSample(alpha: number, beta: number): number {
  const x = gammaSample(alpha);
  const y = gammaSample(beta);
  return x / (x + y);
}

export function conversionRate(conversions: number, visitors: number): number {
  if (visitors <= 0) return 0;
  return conversions / visitors;
}

export function armStats(conversions: number, visitors: number): ArmStats {
  return {
    visitors,
    conversions,
    rate: conversionRate(conversions, visitors),
  };
}

/**
 * P(p_treatment > p_control) with independent Beta(1+s, 1+n-s) posteriors.
 * Flagsmith's own engine uses a normal approximation (chance_to_win). We use
 * this Beta-Binomial Monte Carlo when Flagsmith results are not yet available
 * (self-host without a warehouse, or "collecting data").
 */
export function bayesianWinProbability(
  treatment: { conversions: number; visitors: number },
  control: { conversions: number; visitors: number },
  draws = 20_000,
): number {
  const aT = 1 + treatment.conversions;
  const bT = 1 + Math.max(0, treatment.visitors - treatment.conversions);
  const aC = 1 + control.conversions;
  const bC = 1 + Math.max(0, control.visitors - control.conversions);
  let wins = 0;
  for (let i = 0; i < draws; i += 1) {
    if (betaSample(aT, bT) > betaSample(aC, bC)) wins += 1;
  }
  return wins / draws;
}

export function relativeLift(treatmentRate: number, controlRate: number): number | null {
  if (controlRate <= 0) {
    return treatmentRate > 0 ? Infinity : 0;
  }
  return (treatmentRate - controlRate) / controlRate;
}

export function decideFromWinProbability(
  winProbabilityTreatment: number,
  threshold: number,
): "rollout_treatment" | "pull_to_control" | "keep_running" {
  if (winProbabilityTreatment >= threshold) return "rollout_treatment";
  if (1 - winProbabilityTreatment >= threshold) return "pull_to_control";
  return "keep_running";
}
