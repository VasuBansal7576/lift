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
import { mixLabel } from "../../shared/mix.ts";
import { resultsPath } from "./config.ts";
import type { FlagsmithResultsEnvelope } from "./decide.ts";
import { summariseVisits } from "./decide.ts";
import { clampLift } from "./stats.ts";

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

export function buildResultsDocument(input: {
  decision: ExperimentDecision;
  visits: VisitRecord[];
  flagsmith: FlagsmithResultsEnvelope | null;
  experimentId?: number;
  dashboardUrl?: string;
  personaMix?: PersonaMix;
}) {
  const byVariant = summariseVisits(input.visits);
  const mix = input.personaMix ?? DEFAULT_PERSONA_MIX;
  const fromFlagsmith = input.decision.source === "flagsmith";
  const rawLift = fromFlagsmith
    ? input.decision.lift
    : (input.decision.treatment.rate === 0 && input.decision.control.rate === 0
        ? 0
        : (input.decision.lift ??
          (input.decision.control.rate === 0
            ? Infinity
            : (input.decision.treatment.rate - input.decision.control.rate) /
              input.decision.control.rate)));
  const conversionLift = clampLift(rawLift ?? null);
  const pct =
    conversionLift === null ? "n/a" : `${(conversionLift * 100).toFixed(1)}%`;
  const sourceLabel = fromFlagsmith ? "flagsmith" : "local_estimate";
  const copy = fromFlagsmith
    ? `Flagsmith lift on 1 checkout site: ${pct}.`
    : `LOCAL ESTIMATE (not Flagsmith): ${pct} on 1 checkout site.`;

  return {
    traffic: "simulated" as const,
    label:
      "SIMULATED TRAFFIC — Playwright persona bots, not humans. Demonstration of the pipeline; outcomes follow the persona model, not evidence about real users.",
    generatedAt: new Date().toISOString(),
    site: "checkout",
    sites: 1,
    flag: input.decision.flag,
    experimentId: input.experimentId ?? null,
    flagsmithDashboard: input.dashboardUrl ?? null,
    personaMix: mix,
    personaMixLabel: mixLabel(mix),
    personaMixNote:
      "Mix is a modelling assumption (mouse 70% / keyboard 10% / screen-reader 10% / low-vision 10% by default), not measured traffic.",
    honesty:
      "Barrier flags are wired on the site; this run used the bundled checkout_a11y native experiment. Sequential per-barrier experiments are the attribution path.",
    headline: {
      conversionLift,
      source: sourceLabel,
      copy,
    },
    decision: input.decision,
    flags: [
      {
        name: input.decision.flag,
        role: "experiment",
        control: byVariant.control,
        treatment: byVariant.treatment,
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
