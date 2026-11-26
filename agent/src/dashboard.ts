import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import barriersCatalog from "../../shared/barriers.json" with { type: "json" };
import type { Barrier, ExperimentDecision, Persona, VisitRecord } from "../../shared/types.ts";
import { resultsPath } from "./config.ts";
import type { FlagsmithResultsEnvelope } from "./decide.ts";
import { summariseVisits } from "./decide.ts";

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
}) {
  const byVariant = summariseVisits(input.visits);
  const controlRate = input.decision.control.rate;
  const treatmentRate = input.decision.treatment.rate;
  const headlineLift =
    controlRate === 0
      ? treatmentRate > 0
        ? Infinity
        : 0
      : (treatmentRate - controlRate) / controlRate;

  return {
    traffic: "simulated" as const,
    label: "SIMULATED TRAFFIC — Playwright persona bots, not humans.",
    generatedAt: new Date().toISOString(),
    site: "checkout",
    sites: 1,
    flag: input.decision.flag,
    experimentId: input.experimentId ?? null,
    flagsmithDashboard: input.dashboardUrl ?? null,
    headline: {
      conversionLift: headlineLift,
      copy:
        headlineLift === Infinity
          ? "Treatment converted; control did not (simulated)."
          : `Simulated conversion lift on 1 checkout site: ${(headlineLift * 100).toFixed(1)}%.`,
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
        note: "Created at 0% treatment. The first experiment ships all five fixes behind checkout_a11y to stay inside the free-plan API budget. Sequential per-barrier experiments are the scale-up path.",
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
