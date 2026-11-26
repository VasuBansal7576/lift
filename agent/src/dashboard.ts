import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getSite } from "../../shared/catalog.ts";
import {
  assertNever,
  DEFAULT_PERSONA_MIX,
  type Decision,
  type ExperimentDecision,
  type Persona,
  type PersonaMix,
  type VisitRecord,
} from "../../shared/types.ts";
import { compactMix, mixLabel, realisedMix } from "../../shared/mix.ts";
import { resultsPath } from "./config.ts";
import type { FlagsmithResultsEnvelope } from "./decide.ts";
import { summariseVisits } from "./decide.ts";
import { armStats, clampLift, formatPWin, serialiseLift } from "./stats.ts";

function personaBreakdown(visits: VisitRecord[]) {
  const out: Record<
    Persona,
    { control: { visitors: number; conversions: number }; treatment: { visitors: number; conversions: number } }
  > = {
    mouse: { control: { visitors: 0, conversions: 0 }, treatment: { visitors: 0, conversions: 0 } },
    keyboard: { control: { visitors: 0, conversions: 0 }, treatment: { visitors: 0, conversions: 0 } },
    "screen-reader": { control: { visitors: 0, conversions: 0 }, treatment: { visitors: 0, conversions: 0 } },
    "low-vision": { control: { visitors: 0, conversions: 0 }, treatment: { visitors: 0, conversions: 0 } },
  };
  for (const visit of visits) {
    const arm = out[visit.persona][visit.variant];
    arm.visitors += 1;
    if (visit.converted) arm.conversions += 1;
  }
  return out;
}

export function flagsmithArmCounts(envelope: FlagsmithResultsEnvelope | null): {
  control: { visitors: number; conversions: number };
  treatment: { visitors: number; conversions: number };
} | null {
  const variants = envelope?.results?.payload?.metrics?.[0]?.variants;
  if (!variants?.control) return null;
  const treatment =
    variants.treatment ??
    Object.entries(variants).find(([key]) => key !== "control")?.[1];
  if (!treatment) return null;
  return {
    control: { visitors: variants.control.n ?? 0, conversions: variants.control.sum ?? 0 },
    treatment: { visitors: treatment.n ?? 0, conversions: treatment.sum ?? 0 },
  };
}

export function formatSignedPct(n: number | null | undefined): string | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const pct = n * 100;
  const abs = Math.abs(pct).toFixed(1);
  return pct < 0 ? `−${abs}%` : `+${abs}%`;
}

export function outcomeIntro(
  decision: Decision,
  source: "flagsmith" | "local_bayesian" = "flagsmith",
): string {
  if (source === "local_bayesian") {
    switch (decision) {
      case "keep_running":
        return "Local Beta-Binomial math is inconclusive; the experiment is still running.";
      case "rollout_treatment":
        return "Local Beta-Binomial math favours treatment. Flagsmith has not called this winner unless LIFT_ALLOW_LOCAL_DECISION was set.";
      case "pull_to_control":
        return "Local Beta-Binomial math favours control. Flagsmith has not called this winner unless LIFT_ALLOW_LOCAL_DECISION was set.";
      default:
        return assertNever(decision, "unknown decision");
    }
  }
  switch (decision) {
    case "keep_running":
      return "The experiment is still running; Flagsmith has not called a winner.";
    case "rollout_treatment":
      return "Flagsmith completed the experiment and rolled out treatment.";
    case "pull_to_control":
      return "Flagsmith completed the experiment and pulled to control.";
    default:
      return assertNever(decision, "unknown decision");
  }
}

export function buildHeadlineCopy(input: {
  source: "flagsmith" | "local_bayesian";
  mix: PersonaMix;
  pct: string;
  decision: Decision;
  winProbability: number;
  ciLow: number | null;
  ciHigh: number | null;
}): string {
  const mixCompact = compactMix(input.mix);
  const prefix =
    input.source === "flagsmith"
      ? `Flagsmith lift (SIMULATED traffic, assumed mix ${mixCompact}): ${input.pct}`
      : `local_bayesian lift (SIMULATED traffic, assumed mix ${mixCompact}, not Flagsmith): ${input.pct}`;
  const pWin = `P(win) ${formatPWin(input.winProbability)}`;
  const ciLow = formatSignedPct(input.ciLow);
  const ciHigh = formatSignedPct(input.ciHigh);
  const ci = ciLow && ciHigh ? `95% CI ${ciLow} to ${ciHigh}` : null;
  switch (input.decision) {
    case "keep_running":
      return [prefix, "NOT significant", pWin, ci, "keep running"].filter(Boolean).join(", ");
    case "rollout_treatment":
      return [prefix, pWin, ci, "rolled out"].filter(Boolean).join(", ");
    case "pull_to_control":
      return [prefix, pWin, ci, "pulled to control"].filter(Boolean).join(", ");
    default:
      return assertNever(input.decision, "unknown decision");
  }
}

export function buildResultsDocument(input: {
  decision: ExperimentDecision;
  visits: VisitRecord[];
  flagsmith: FlagsmithResultsEnvelope | null;
  experimentId?: number;
  dashboardUrl?: string;
  personaMix?: PersonaMix;
  site?: string;
  verification?: {
    applied: boolean;
    n: number;
    matched: number;
    expected: string | null;
    usedFallback: boolean;
  } | null;
}) {
  const localByVariant = summariseVisits(input.visits);
  const mix = input.personaMix ?? DEFAULT_PERSONA_MIX;
  const realised = realisedMix(input.visits.map((v) => v.persona));
  const fromFlagsmith = input.decision.source === "flagsmith";
  const flagsmithArms = fromFlagsmith ? flagsmithArmCounts(input.flagsmith) : null;
  const notes = [...input.decision.notes];
  let control = localByVariant.control;
  let treatment = localByVariant.treatment;
  if (fromFlagsmith && flagsmithArms) {
    control = flagsmithArms.control;
    treatment = flagsmithArms.treatment;
    const mismatch =
      flagsmithArms.control.visitors !== localByVariant.control.visitors ||
      flagsmithArms.control.conversions !== localByVariant.control.conversions ||
      flagsmithArms.treatment.visitors !== localByVariant.treatment.visitors ||
      flagsmithArms.treatment.conversions !== localByVariant.treatment.conversions;
    if (mismatch) {
      notes.push(
        `Local visit counts differ from Flagsmith n/sum (local control ${localByVariant.control.conversions}/${localByVariant.control.visitors}, treatment ${localByVariant.treatment.conversions}/${localByVariant.treatment.visitors}; Flagsmith control ${flagsmithArms.control.conversions}/${flagsmithArms.control.visitors}, treatment ${flagsmithArms.treatment.conversions}/${flagsmithArms.treatment.visitors}). Using Flagsmith n/sum.`,
      );
    }
  }
  if (input.flagsmith?.results?.is_final === false) {
    notes.push(
      "Embedded Flagsmith snapshot was taken before completion (results.is_final is false).",
    );
  }
  const rawLift = fromFlagsmith
    ? input.decision.lift
    : (input.decision.treatment.rate === 0 && input.decision.control.rate === 0
        ? 0
        : (input.decision.lift ??
          (input.decision.control.rate === 0
            ? Infinity
            : (input.decision.treatment.rate - input.decision.control.rate) /
              input.decision.control.rate)));
  const conversionLift = serialiseLift(rawLift ?? null);
  const displayLift = clampLift(rawLift ?? null);
  const pct =
    displayLift === null ? "n/a" : `${(displayLift * 100).toFixed(1)}%`;
  const sourceLabel = fromFlagsmith ? "flagsmith" : "local_bayesian";
  const copy = buildHeadlineCopy({
    source: sourceLabel,
    mix,
    pct,
    decision: input.decision.decision,
    winProbability: input.decision.winProbabilityTreatment,
    ciLow: input.decision.ciLow,
    ciHigh: input.decision.ciHigh,
  });

  const flagsmithTotal = flagsmithArms
    ? flagsmithArms.control.visitors + flagsmithArms.treatment.visitors
    : null;
  const localTotal =
    localByVariant.control.visitors + localByVariant.treatment.visitors;
  const serialisedDecision = {
    ...input.decision,
    lift: serialiseLift(input.decision.lift),
    control:
      fromFlagsmith && flagsmithArms
        ? armStats(flagsmithArms.control.conversions, flagsmithArms.control.visitors)
        : input.decision.control,
    treatment:
      fromFlagsmith && flagsmithArms
        ? armStats(flagsmithArms.treatment.conversions, flagsmithArms.treatment.visitors)
        : input.decision.treatment,
    notes,
  };

  return {
    traffic: "simulated" as const,
    label:
      "SIMULATED TRAFFIC — Playwright persona bots, not humans. Demonstration of the pipeline; outcomes follow the persona model, not evidence about real users. Lift is a function of the assumed share of keyboard, screen-reader and low-vision users.",
    generatedAt: new Date().toISOString(),
    site: input.site ?? "checkout",
    sites: 1,
    flag: input.decision.flag,
    experimentId: input.experimentId ?? null,
    flagsmithDashboard: input.dashboardUrl ?? null,
    personaMix: mix,
    personaMixLabel: mixLabel(mix),
    realisedMix: realised,
    realisedMixLabel: mixLabel(realised),
    personaMixNote: `Assumed mix is a modelling choice (${mixLabel(mix)}), not measured traffic. realisedMix is this run's actual draws. Win threshold is ${(input.decision.threshold * 100).toFixed(0)}%.`,
    localArms: localByVariant,
    personasNote: flagsmithTotal !== null
      ? `local visit log, n=${localTotal}; Flagsmith counted n=${flagsmithTotal}`
      : `local visit log, n=${localTotal}`,
    outcome: outcomeIntro(input.decision.decision, input.decision.source),
    honesty:
      `Barrier flags are wired on the site; this run used the bundled ${input.decision.flag} native experiment. Sequential per-barrier experiments are the attribution path.`,
    headline: {
      conversionLift,
      displayLift,
      source: sourceLabel,
      copy,
      ciLow: input.decision.ciLow,
      ciHigh: input.decision.ciHigh,
    },
    decision: serialisedDecision,
    flags: [
      {
        name: input.decision.flag,
        role: "experiment",
        control,
        treatment,
        armSource: fromFlagsmith ? "flagsmith" : "local_bayesian",
        winProbabilityTreatment: input.decision.winProbabilityTreatment,
        ciLow: input.decision.ciLow,
        ciHigh: input.decision.ciHigh,
        source: input.decision.source,
        decision: input.decision.decision,
      },
      ...getSite(input.site ?? "checkout").barriers.map((barrier) => ({
        name: barrier.flag,
        role: "barrier",
        title: barrier.title,
        wcag: barrier.wcag,
        blocks: barrier.blocks,
        note: `Wired on the ${input.site ?? "checkout"} page. Bundled experiment ${input.decision.flag} is the native-Experiments path; per-barrier flags stay at 0% treatment until a sequential run.`,
      })),
    ],
    personas: personaBreakdown(input.visits),
    barriers: getSite(input.site ?? "checkout").barriers,
    visits: input.visits.length,
    flagsmithResults: input.flagsmith,
    rolloutVerification: input.verification ?? null,
  };
}

export function writeDashboard(
  doc: ReturnType<typeof buildResultsDocument>,
  path = resultsPath(String(doc.site ?? "checkout")),
) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  return path;
}
