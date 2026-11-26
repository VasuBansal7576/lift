import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import barriersCatalog from "../../shared/barriers.json" with { type: "json" };
import type {
  Barrier,
  ExperimentDecision,
  Persona,
  PersonaMix,
  VisitRecord,
} from "../../shared/types.ts";
import { DEFAULT_PERSONA_MIX } from "../../shared/types.ts";
import { mixLabel, realisedMix } from "../../shared/mix.ts";
import { resultsPath } from "./config.ts";
import type { FlagsmithResultsEnvelope } from "./decide.ts";
import { summariseVisits } from "./decide.ts";
import { clampLift, serialiseLift } from "./stats.ts";

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

function compactMix(mix: PersonaMix): string {
  return `${Math.round(mix.mouse * 100)}/${Math.round(mix.keyboard * 100)}/${Math.round(mix["screen-reader"] * 100)}/${Math.round(mix["low-vision"] * 100)}`;
}

export function buildResultsDocument(input: {
  decision: ExperimentDecision;
  visits: VisitRecord[];
  flagsmith: FlagsmithResultsEnvelope | null;
  experimentId?: number;
  dashboardUrl?: string;
  personaMix?: PersonaMix;
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
  const mixCompact = compactMix(mix);
  const copy = fromFlagsmith
    ? `Flagsmith lift (SIMULATED traffic, assumed mix ${mixCompact}): ${pct}`
    : `local_bayesian lift (SIMULATED traffic, assumed mix ${mixCompact}, not Flagsmith): ${pct}`;

  const serialisedDecision = {
    ...input.decision,
    lift: serialiseLift(input.decision.lift),
    notes,
  };

  return {
    traffic: "simulated" as const,
    label:
      "SIMULATED TRAFFIC — Playwright persona bots, not humans. Demonstration of the pipeline; outcomes follow the persona model, not evidence about real users. Lift is a function of the assumed share of keyboard, screen-reader and low-vision users.",
    generatedAt: new Date().toISOString(),
    site: "checkout",
    sites: 1,
    flag: input.decision.flag,
    experimentId: input.experimentId ?? null,
    flagsmithDashboard: input.dashboardUrl ?? null,
    personaMix: mix,
    personaMixLabel: mixLabel(mix),
    realisedMix: realised,
    realisedMixLabel: mixLabel(realised),
    personaMixNote:
      "Assumed mix is a modelling choice (mouse 70% / keyboard 10% / screen-reader 10% / low-vision 10% by default), not measured traffic. realisedMix is this run's actual draws.",
    honesty:
      "Barrier flags are wired on the site; this run used the bundled checkout_a11y native experiment. Sequential per-barrier experiments are the attribution path.",
    headline: {
      conversionLift,
      displayLift,
      source: sourceLabel,
      copy,
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
        source: input.decision.source,
        decision: input.decision.decision,
      },
      ...(barriersCatalog as Barrier[]).map((barrier) => ({
        name: barrier.flag,
        role: "barrier",
        title: barrier.title,
        wcag: barrier.wcag,
        blocks: barrier.blocks,
        note: "Wired on the checkout page. Bundled experiment checkout_a11y is the native-Experiments path; per-barrier flags stay at 0% treatment until a sequential run.",
      })),
    ],
    personas: personaBreakdown(input.visits),
    barriers: barriersCatalog,
    visits: input.visits.length,
    flagsmithResults: input.flagsmith,
  };
}

export function writeDashboard(doc: ReturnType<typeof buildResultsDocument>) {
  mkdirSync(dirname(resultsPath()), { recursive: true });
  writeFileSync(resultsPath(), `${JSON.stringify(doc, null, 2)}\n`);
  return resultsPath();
}
