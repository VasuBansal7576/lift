import { mulberry32 } from "../../shared/rng.ts";
import type { ArmStats } from "../../shared/types.ts";

function gammaSample(shape: number, rand: () => number): number {
  if (shape < 1) {
    return gammaSample(shape + 1, rand) * Math.pow(rand(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normalSample(rand);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function normalSample(rand: () => number): number {
  const u = 1 - rand();
  const v = 1 - rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function betaSample(alpha: number, beta: number, rand: () => number): number {
  const x = gammaSample(alpha, rand);
  const y = gammaSample(beta, rand);
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
 * Seeded Monte Carlo. Used only when Flagsmith chance_to_win is unavailable.
 */
export function bayesianWinProbability(
  treatment: { conversions: number; visitors: number },
  control: { conversions: number; visitors: number },
  draws = 20_000,
  seed = 20261126,
): number {
  const rand = mulberry32(seed);
  const aT = 1 + treatment.conversions;
  const bT = 1 + Math.max(0, treatment.visitors - treatment.conversions);
  const aC = 1 + control.conversions;
  const bC = 1 + Math.max(0, control.visitors - control.conversions);
  let wins = 0;
  for (let i = 0; i < draws; i += 1) {
    if (betaSample(aT, bT, rand) > betaSample(aC, bC, rand)) wins += 1;
  }
  return wins / draws;
}

export function relativeLift(treatmentRate: number, controlRate: number): number | null {
  if (controlRate <= 0) {
    return treatmentRate > 0 ? Infinity : 0;
  }
  return (treatmentRate - controlRate) / controlRate;
}

/** Finite lift for display. Infinity (control rate 0) clamps to 10 (1000%). */
export function clampLift(lift: number | null): number | null {
  if (lift === null) return null;
  if (!Number.isFinite(lift)) return lift > 0 ? 10 : -10;
  return Math.max(-10, Math.min(10, lift));
}

/** JSON-safe lift: Infinity must not become null. */
export function serialiseLift(
  lift: number | null,
): number | "Infinity" | "-Infinity" | null {
  if (lift === null) return null;
  if (lift === Infinity) return "Infinity";
  if (lift === -Infinity) return "-Infinity";
  if (!Number.isFinite(lift)) return lift > 0 ? "Infinity" : "-Infinity";
  return lift;
}

/** Complementary error function (Abramowitz & Stegun 7.1.26). */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    t *
    (0.254829592 +
      t *
        (-0.284496736 +
          t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) *
    Math.exp(-z * z);
  return x >= 0 ? y : 2 - y;
}

/** Survival function of chi-square with 1 df. */
export function chiSquareDf1P(chi: number): number {
  if (!Number.isFinite(chi) || chi <= 0) return 1;
  return erfc(Math.sqrt(chi / 2));
}

/** Pearson SRM p-value for two arms vs expected allocation (default 50/50). */
export function srmPValue(
  nControl: number,
  nTreatment: number,
  expectedControlShare = 0.5,
): number {
  const n = nControl + nTreatment;
  if (n <= 0) return 1;
  const p = Math.min(0.999, Math.max(0.001, expectedControlShare));
  const eC = n * p;
  const eT = n * (1 - p);
  const chi = (nControl - eC) ** 2 / eC + (nTreatment - eT) ** 2 / eT;
  return chiSquareDf1P(chi);
}

export function formatPWin(p: number): string {
  if (!Number.isFinite(p)) return "n/a";
  if (p >= 0.999) return ">99.9%";
  if (p <= 0.001) return "<0.1%";
  return `${(p * 100).toFixed(1)}%`;
}

export function decideFromWinProbability(
  winProbabilityTreatment: number,
  threshold: number,
): "rollout_treatment" | "pull_to_control" | "keep_running" {
  if (winProbabilityTreatment >= threshold) return "rollout_treatment";
  if (1 - winProbabilityTreatment >= threshold) return "pull_to_control";
  return "keep_running";
}
