import { DEFAULT_PERSONA_MIX, type Decision, type PersonaMix } from "./types.ts";
import { compactMix } from "./mix.ts";

export interface SiteRow {
  site: string;
  name: string;
  flag: string;
  experimentId: number | null;
  flagsmithDashboard: string | null;
  control: { visitors: number; conversions: number; rate: number };
  treatment: { visitors: number; conversions: number; rate: number };
  lift: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  winProbabilityTreatment: number;
  decision: Decision;
  source: "flagsmith" | "local_bayesian";
}

export interface FleetAggregate {
  method: "median_of_site_lifts";
  explanation: string;
  siteCount: number;
  medianLift: number | null;
  pooledLift: number | null;
  pooledControl: { visitors: number; conversions: number; rate: number };
  pooledTreatment: { visitors: number; conversions: number; rate: number };
  headline: string;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function rate(conversions: number, visitors: number): number {
  return visitors === 0 ? 0 : conversions / visitors;
}

export function aggregateSites(
  rows: SiteRow[],
  mix: PersonaMix = DEFAULT_PERSONA_MIX,
): FleetAggregate {
  const usable = rows.filter((row) => Number.isFinite(row.lift ?? NaN));
  const lifts = usable
    .map((row) => row.lift)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  const medianLift = median(lifts);
  const pooledControl = {
    visitors: rows.reduce((sum, row) => sum + row.control.visitors, 0),
    conversions: rows.reduce((sum, row) => sum + row.control.conversions, 0),
    rate: 0,
  };
  pooledControl.rate = rate(pooledControl.conversions, pooledControl.visitors);
  const pooledTreatment = {
    visitors: rows.reduce((sum, row) => sum + row.treatment.visitors, 0),
    conversions: rows.reduce((sum, row) => sum + row.treatment.conversions, 0),
    rate: 0,
  };
  pooledTreatment.rate = rate(pooledTreatment.conversions, pooledTreatment.visitors);
  const pooledLift =
    pooledControl.rate === 0
      ? null
      : (pooledTreatment.rate - pooledControl.rate) / pooledControl.rate;
  const display =
    medianLift === null ? "n/a" : `${(medianLift * 100).toFixed(1)}%`;
  const explanation =
    "Headline is the unweighted median of per-site relative lifts (treatment vs control conversion rate). " +
    "Sites are not a sample of the web; each row is its own experiment with an assumed persona mix. " +
    "Pooled lift (visitors summed across sites) is shown as a sensitivity check — it weights larger n more, " +
    "and it is not the headline because sites have different flows and are not exchangeable.";
  const headline = `conversion lift across ${rows.length} sites (SIMULATED traffic, assumed mix ${compactMix(mix)}): ${display} median`;
  return {
    method: "median_of_site_lifts",
    explanation,
    siteCount: rows.length,
    medianLift,
    pooledLift,
    pooledControl,
    pooledTreatment,
    headline,
  };
}

export function decisionLabel(decision: Decision): string {
  switch (decision) {
    case "rollout_treatment":
      return "rolled out";
    case "pull_to_control":
      return "pulled";
    case "keep_running":
      return "still running";
    default: {
      const _exhaustive: never = decision;
      throw new Error(`Unhandled decision ${_exhaustive}`);
    }
  }
}

export function siteRowFromDocument(doc: {
  site?: string;
  flag?: string;
  experimentId?: number | null;
  flagsmithDashboard?: string | null;
  decision: {
    flag: string;
    decision: Decision;
    source: "flagsmith" | "local_bayesian";
    winProbabilityTreatment: number;
    lift: number | string | null;
    ciLow: number | null;
    ciHigh: number | null;
    control: { visitors: number; conversions: number; rate: number };
    treatment: { visitors: number; conversions: number; rate: number };
  };
  headline?: { conversionLift?: number | string | null };
}): SiteRow {
  const liftRaw = doc.decision.lift ?? doc.headline?.conversionLift ?? null;
  const lift =
    typeof liftRaw === "number"
      ? liftRaw
      : liftRaw === "Infinity"
        ? Number.POSITIVE_INFINITY
        : liftRaw === "-Infinity"
          ? Number.NEGATIVE_INFINITY
          : null;
  return {
    site: doc.site ?? doc.decision.flag,
    name: doc.site ?? doc.decision.flag,
    flag: doc.flag ?? doc.decision.flag,
    experimentId: doc.experimentId ?? null,
    flagsmithDashboard: doc.flagsmithDashboard ?? null,
    control: doc.decision.control,
    treatment: doc.decision.treatment,
    lift,
    ciLow: doc.decision.ciLow,
    ciHigh: doc.decision.ciHigh,
    winProbabilityTreatment: doc.decision.winProbabilityTreatment,
    decision: doc.decision.decision,
    source: doc.decision.source,
  };
}

