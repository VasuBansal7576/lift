import { DEFAULT_PERSONA_MIX, type Decision, type PersonaMix, type SrmSource } from "./types.ts";
import {
  blockedPersonaShare,
  expectedLiftByConstruction,
  getSite,
  PRICING_FRICTION_DISCLOSURE,
} from "./catalog.ts";
import { compactMix } from "./mix.ts";
import { gitCommitSha } from "./git.ts";

export type ProducedBy = "fleet" | "snapshot" | "reused" | "experiment" | "rebuild";

/**
 * When false (default), the headline uses the 7 real fixes and shows pricing
 * as a designed-to-lose pipeline check. Set HEADLINE_INCLUDE_DESIGNED_TO_LOSE=true
 * to count all 8 sites in the headline.
 */
export const HEADLINE_INCLUDE_DESIGNED_TO_LOSE = false;

export const LIFT_CONSTRUCTION_NOTE =
  "The size of the lift is set by the assumed persona mix and which personas each barrier blocks; this demonstrates the Flagsmith pipeline, not real-user impact.";

export interface SiteRow {
  site: string;
  name: string;
  flag: string;
  experimentId: number | null;
  flagsmithDashboard: string | null;
  control: { visitors: number; conversions: number; rate: number };
  treatment: { visitors: number; conversions: number; rate: number };
  lift: number | null;
  expectedLift: number | null;
  blockedShare: number | null;
  designedToLose: boolean;
  frictionDisclosure: string | null;
  ciLow: number | null;
  ciHigh: number | null;
  winProbabilityTreatment: number;
  decision: Decision;
  source: "flagsmith" | "local_bayesian";
  srmPValue: number | null;
  srmSource: SrmSource | null;
  producedBy: ProducedBy;
  commitSha: string;
}

export interface LiftSummary {
  siteCount: number;
  medianLift: number | null;
  iqrLow: number | null;
  iqrHigh: number | null;
  liftMin: number | null;
  liftMax: number | null;
  pooledLift: number | null;
  pooledControl: { visitors: number; conversions: number; rate: number };
  pooledTreatment: { visitors: number; conversions: number; rate: number };
  pooledCopy: string;
  headline: string;
}

export interface FleetAggregate extends LiftSummary {
  method: "median_of_site_lifts";
  headlineIncludesDesignedToLose: boolean;
  explanation: string;
  constructionNote: string;
  pipelineCheckNote: string;
  multipleTestingNote: string;
  /** The other scope (all 8 if headline is 7, or the 7 real fixes if headline is 8). */
  secondary: LiftSummary;
  designedToLoseSites: string[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function quantile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - idx) + sorted[hi] * (idx - lo);
}

function rate(conversions: number, visitors: number): number {
  return visitors === 0 ? 0 : conversions / visitors;
}

export function formatSignedPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  const pct = n * 100;
  const abs = Math.abs(pct).toFixed(1);
  return pct < 0 ? `−${abs}%` : `${abs}%`;
}

export function isDesignedToLose(row: SiteRow): boolean {
  if (row.designedToLose) return true;
  try {
    return getSite(row.site).harmfulFix?.designedToLose === true;
  } catch {
    return false;
  }
}

export function headlineRows(
  rows: SiteRow[],
  includeDesignedToLose = HEADLINE_INCLUDE_DESIGNED_TO_LOSE,
): SiteRow[] {
  if (includeDesignedToLose) return rows;
  return rows.filter((row) => !isDesignedToLose(row));
}

export function borderlineSites(rows: SiteRow[]): string[] {
  return rows
    .filter((row) => {
      if (row.decision === "keep_running") return false;
      const p = row.winProbabilityTreatment;
      const closeWin = p >= 0.95 && p < 0.99;
      const closeLose = p > 0.01 && p <= 0.05;
      const ciBarelyExcludesZero =
        typeof row.ciLow === "number" && row.ciLow > 0 && row.ciLow < 0.05;
      return closeWin || closeLose || ciBarelyExcludesZero;
    })
    .map((row) => row.site);
}

function summariseRows(
  rows: SiteRow[],
  mix: PersonaMix,
  label: string,
): LiftSummary {
  const usable = rows.filter((row) => Number.isFinite(row.lift ?? NaN));
  const lifts = usable
    .map((row) => row.lift)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  const sorted = [...lifts].sort((a, b) => a - b);
  const medianLift = median(lifts);
  const iqrLow = quantile(sorted, 0.25);
  const iqrHigh = quantile(sorted, 0.75);
  const liftMin = sorted.length ? sorted[0] : null;
  const liftMax = sorted.length ? sorted[sorted.length - 1] : null;
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
  const iqrCopy =
    iqrLow === null || iqrHigh === null
      ? ""
      : ` (IQR ${formatSignedPct(iqrLow)} to ${formatSignedPct(iqrHigh)}; range ${formatSignedPct(liftMin)} to ${formatSignedPct(liftMax)})`;
  const headline = `${label} (SIMULATED traffic, assumed mix ${compactMix(mix)}): ${display} median${iqrCopy}`;
  const pooledCopy =
    pooledLift === null
      ? "Pooled sensitivity: n/a."
      : `Pooled sensitivity (summed n, not the headline): ${formatSignedPct(pooledLift)} (control ${pooledControl.conversions}/${pooledControl.visitors} vs treatment ${pooledTreatment.conversions}/${pooledTreatment.visitors}).`;
  return {
    siteCount: rows.length,
    medianLift,
    iqrLow,
    iqrHigh,
    liftMin,
    liftMax,
    pooledLift,
    pooledControl,
    pooledTreatment,
    pooledCopy,
    headline,
  };
}

export function aggregateSites(
  rows: SiteRow[],
  mix: PersonaMix = DEFAULT_PERSONA_MIX,
  includeDesignedToLose = HEADLINE_INCLUDE_DESIGNED_TO_LOSE,
): FleetAggregate {
  const designedToLoseSites = rows.filter((row) => isDesignedToLose(row)).map((row) => row.site);
  const realFixes = rows.filter((row) => !isDesignedToLose(row));
  const primaryRows = includeDesignedToLose ? rows : realFixes;
  const secondaryRows = includeDesignedToLose ? realFixes : rows;
  const primaryLabel = includeDesignedToLose
    ? `conversion lift across ${rows.length} sites`
    : `conversion lift across ${realFixes.length} sites`;
  const secondaryLabel = includeDesignedToLose
    ? `Real fixes only (${realFixes.length} sites)`
    : `Including the designed-to-lose pipeline check (${rows.length} sites)`;
  const primary = summariseRows(primaryRows, mix, primaryLabel);
  const secondary = summariseRows(secondaryRows, mix, secondaryLabel);
  const explanation = includeDesignedToLose
    ? "Headline is the unweighted median of per-site relative lifts across every site, including designed-to-lose pipeline checks. Sites are not a sample of the web; each row is its own experiment with an assumed persona mix. Pooled lift (visitors summed across headline sites) is shown as a sensitivity check — it weights larger n more, and it is not the headline because sites have different flows and are not exchangeable."
    : "Headline is the unweighted median of per-site relative lifts on the real accessibility fixes (pricing is excluded from the headline as a designed-to-lose pull_to_control pipeline check). Sites are not a sample of the web; each row is its own experiment with an assumed persona mix. Pooled lift (visitors summed across headline sites) is shown as a sensitivity check — it weights larger n more, and it is not the headline because sites have different flows and are not exchangeable.";
  const pipelineCheckNote = designedToLoseSites.length
    ? `${designedToLoseSites.join(", ")} ${designedToLoseSites.length === 1 ? "is" : "are"} a designed-to-lose pull_to_control pipeline check, shown separately from the headline.`
    : "";
  const borderline = borderlineSites(rows);
  const multipleTestingNote =
    `${rows.length} separate tests were run at 95% with no multiple-testing correction` +
    (borderline.length
      ? `; ${borderline.join(" and ")} ${borderline.length === 1 ? "is" : "are"} borderline.`
      : ".");
  return {
    method: "median_of_site_lifts",
    headlineIncludesDesignedToLose: includeDesignedToLose,
    explanation,
    constructionNote: LIFT_CONSTRUCTION_NOTE,
    pipelineCheckNote,
    multipleTestingNote,
    designedToLoseSites,
    ...primary,
    secondary,
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
  producedBy?: ProducedBy;
  commitSha?: string;
  expectedLift?: number | null;
  blockedShare?: number | null;
  designedToLose?: boolean;
  frictionDisclosure?: string | null;
  decision: {
    flag: string;
    decision: Decision;
    source: "flagsmith" | "local_bayesian";
    winProbabilityTreatment: number;
    lift: number | string | null;
    ciLow: number | null;
    ciHigh: number | null;
    srmPValue?: number | null;
    srmSource?: SrmSource | null;
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
  let designedToLose = doc.designedToLose === true;
  let expectedLift = typeof doc.expectedLift === "number" ? doc.expectedLift : null;
  let blockedShare: number | null =
    typeof doc.blockedShare === "number" ? doc.blockedShare : null;
  let frictionDisclosure = doc.frictionDisclosure ?? null;
  try {
    const site = getSite(String(doc.site ?? ""));
    designedToLose = site.harmfulFix?.designedToLose === true;
    expectedLift = expectedLiftByConstruction(site);
    blockedShare = blockedPersonaShare(site);
    frictionDisclosure = designedToLose ? PRICING_FRICTION_DISCLOSURE : null;
  } catch {
    // Dummy rows in unit tests are not catalog sites.
  }

  return {
    site: doc.site ?? doc.decision.flag,
    name: doc.site ?? doc.decision.flag,
    flag: doc.flag ?? doc.decision.flag,
    experimentId: doc.experimentId ?? null,
    flagsmithDashboard: doc.flagsmithDashboard ?? null,
    control: doc.decision.control,
    treatment: doc.decision.treatment,
    lift,
    expectedLift,
    blockedShare,
    designedToLose,
    frictionDisclosure,
    ciLow: doc.decision.ciLow,
    ciHigh: doc.decision.ciHigh,
    winProbabilityTreatment: doc.decision.winProbabilityTreatment,
    decision: doc.decision.decision,
    source: doc.decision.source,
    srmPValue: doc.decision.srmPValue ?? null,
    srmSource: doc.decision.srmSource ?? null,
    producedBy: doc.producedBy ?? "fleet",
    commitSha: doc.commitSha ?? gitCommitSha(),
  };
}
