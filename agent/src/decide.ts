import { readFileSync } from "node:fs";
import type { ExperimentDecision, Variant, VisitRecord } from "../../shared/types.ts";
import { eventsPath, loadConfig, readJson, statePath } from "./config.ts";
import {
  FlagsmithAdmin,
  type ExperimentRecord,
} from "./flagsmith-admin.ts";
import type { BootstrapState } from "./bootstrap.ts";
import {
  armStats,
  bayesianWinProbability,
  decideFromWinProbability,
  relativeLift,
} from "./stats.ts";

export interface FlagsmithResultsPayload {
  srm_p_value?: number | null;
  metrics?: Array<{
    metric_id?: number;
    variants?: Record<
      string,
      { n?: number; sum?: number; sum_squares?: number; mean?: number }
    >;
    inference?: Record<
      string,
      {
        lift?: number;
        ci_low?: number;
        ci_high?: number;
        chance_to_win?: number;
      } | null
    >;
  }>;
}

export interface FlagsmithResultsEnvelope {
  results?: {
    as_of?: string | null;
    payload?: FlagsmithResultsPayload | null;
    last_error_at?: string | null;
    is_final?: boolean;
  } | null;
}

export function loadVisits(path = eventsPath()): VisitRecord[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as VisitRecord);
  } catch {
    return [];
  }
}

export function summariseVisits(visits: VisitRecord[]) {
  const byVariant: Record<Variant, { conversions: number; visitors: number }> = {
    control: { conversions: 0, visitors: 0 },
    treatment: { conversions: 0, visitors: 0 },
  };
  for (const visit of visits) {
    byVariant[visit.variant].visitors += 1;
    if (visit.converted) byVariant[visit.variant].conversions += 1;
  }
  return byVariant;
}

export function parseFlagsmithWin(
  envelope: FlagsmithResultsEnvelope | null,
  treatmentKey = "treatment",
): { chanceToWin: number; lift: number | null; asOf: string | null } | null {
  const payload = envelope?.results?.payload;
  const inference = payload?.metrics?.[0]?.inference;
  if (!inference) return null;
  const arm =
    inference[treatmentKey] ??
    Object.entries(inference).find(([key]) => key !== "control")?.[1];
  if (!arm || typeof arm.chance_to_win !== "number") return null;
  return {
    chanceToWin: arm.chance_to_win,
    lift: typeof arm.lift === "number" ? arm.lift : null,
    asOf: envelope?.results?.as_of ?? null,
  };
}

export function decideExperiment(input: {
  flag: string;
  visits: VisitRecord[];
  flagsmith?: FlagsmithResultsEnvelope | null;
  threshold: number;
}): ExperimentDecision {
  const byVariant = summariseVisits(input.visits);
  const control = armStats(
    byVariant.control.conversions,
    byVariant.control.visitors,
  );
  const treatment = armStats(
    byVariant.treatment.conversions,
    byVariant.treatment.visitors,
  );
  const notes: string[] = [
    "All traffic is SIMULATED (Playwright persona bots, not humans).",
  ];

  const parsed = parseFlagsmithWin(input.flagsmith);
  const collecting =
    control.visitors < 50 ||
    treatment.visitors < 50 ||
    control.conversions < 5 ||
    treatment.conversions < 5;

  let source: ExperimentDecision["source"] = "local_bayesian";
  let winProbabilityTreatment = bayesianWinProbability(treatment, control);
  let lift = relativeLift(treatment.rate, control.rate);

  if (parsed && !collecting) {
    source = "flagsmith";
    winProbabilityTreatment = parsed.chanceToWin;
    lift = parsed.lift;
    notes.push(
      "Win probability from Flagsmith Experimentation (chance_to_win on the results payload).",
    );
    if (parsed.asOf) notes.push(`Flagsmith results as of ${parsed.asOf}.`);
  } else if (parsed && collecting) {
    notes.push(
      "Flagsmith results exist but a variant is still under the 50-identity / 5-conversion floor, so Lift uses a local Beta-Binomial win probability.",
    );
  } else {
    notes.push(
      "Flagsmith native results were not available (warehouse still connecting, self-host without events, or refresh pending). Win probability is a local Beta-Binomial Monte Carlo, same decision rule as Flagsmith's 95% chance-to-be-best.",
    );
  }

  const decision = decideFromWinProbability(
    winProbabilityTreatment,
    input.threshold,
  );

  switch (decision) {
    case "rollout_treatment":
      notes.push("Treatment wins: complete the experiment rolling out the treatment variant.");
      break;
    case "pull_to_control":
      notes.push("Treatment loses: complete the experiment returning to control.");
      break;
    case "keep_running":
      notes.push("Inconclusive: leave the experiment running.");
      break;
    default: {
      const _exhaustive: never = decision;
      throw new Error(`Unhandled decision ${_exhaustive}`);
    }
  }

  return {
    flag: input.flag,
    decision,
    source,
    winProbabilityTreatment,
    lift,
    control,
    treatment,
    threshold: input.threshold,
    notes,
  };
}

export async function fetchFlagsmithResults(
  experimentId: number,
): Promise<FlagsmithResultsEnvelope | null> {
  const cfg = loadConfig();
  if (!cfg.adminToken || !cfg.environmentKey) return null;
  const admin = new FlagsmithAdmin(cfg);
  try {
    await admin.post(
      `/environments/${cfg.environmentKey}/experiments/${experimentId}/results/refresh/`,
    );
  } catch {
    // 429 if refreshed in the last 5 minutes, or 400 if not started — keep going.
  }
  const { data } = await admin.get<FlagsmithResultsEnvelope>(
    `/environments/${cfg.environmentKey}/experiments/${experimentId}/results/`,
  );
  return data;
}

export async function applyDecision(decision: ExperimentDecision): Promise<void> {
  const cfg = loadConfig();
  const state = readJson<BootstrapState>(statePath());
  if (!state || !cfg.adminToken || !cfg.environmentKey) {
    throw new Error("Bootstrap state and Flagsmith admin credentials are required to roll out");
  }
  const admin = new FlagsmithAdmin(cfg);
  const { data: experiment } = await admin.get<ExperimentRecord>(
    `/environments/${cfg.environmentKey}/experiments/${state.experimentId}/`,
  );

  if (decision.decision === "keep_running") return;
  if (experiment.status === "completed") return;

  const body =
    decision.decision === "rollout_treatment"
      ? {
          rollout_decision: "variant",
          rollout_variant: state.treatmentOptionId,
        }
      : { rollout_decision: "control" };

  await admin.post(
    `/environments/${cfg.environmentKey}/experiments/${state.experimentId}/complete/`,
    body,
  );
}

async function main() {
  const cfg = loadConfig();
  const state = readJson<BootstrapState>(statePath());
  const visits = loadVisits();
  const flagsmith = state
    ? await fetchFlagsmithResults(state.experimentId)
    : null;
  const decision = decideExperiment({
    flag: cfg.flagName,
    visits,
    flagsmith,
    threshold: cfg.winThreshold,
  });
  if (decision.decision !== "keep_running") {
    await applyDecision(decision);
  }
  process.stdout.write(`${JSON.stringify({ decision, flagsmith }, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : err}\n`);
    process.exit(1);
  });
}
