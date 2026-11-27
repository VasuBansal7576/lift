import type { EventLog } from "../log.ts";
import type { AnalystRecommendation, FlagSetup, FlagVariantRecord, OrchOptions } from "../types.ts";
import { FlagsmithHttp } from "../flagsmith/http.ts";
import { listResults } from "../flagsmith/http.ts";

export interface RolloutResult {
  completed: boolean;
  winner: string;
  experimentId: number;
  cleaned: string[];
}

export function completeBody(
  winner: string,
  controlKey: string,
  variants: FlagVariantRecord[],
): { rollout_decision: "variant" | "control"; rollout_variant?: number } {
  if (winner === controlKey || winner === "control") {
    return { rollout_decision: "control" };
  }
  const option = variants.find((item) => item.key === winner);
  if (!option) {
    throw new Error(`Unknown rollout arm ${winner}`);
  }
  return { rollout_decision: "variant", rollout_variant: option.optionId };
}

export function pickEnvDefaultFeatureState<T extends { identity?: unknown; feature_segment?: unknown }>(
  states: T[],
): T {
  const found = states.find((state) => state.identity == null && state.feature_segment == null);
  if (!found) {
    throw new Error("No environment-default featurestate (identity==null && feature_segment==null)");
  }
  return found;
}

export function winnerAllocations(
  rows: Array<{
    id?: number;
    multivariate_feature_option: number | { id: number };
    percentage_allocation: number;
  }>,
  winnerOptionId: number | undefined,
): Array<{ id?: number; multivariate_feature_option: number; percentage_allocation: number }> {
  return rows.map((row) => {
    const optionId =
      typeof row.multivariate_feature_option === "number"
        ? row.multivariate_feature_option
        : row.multivariate_feature_option.id;
    const isWinner = winnerOptionId !== undefined && optionId === winnerOptionId;
    return {
      id: row.id,
      multivariate_feature_option: optionId,
      percentage_allocation: isWinner ? 100 : 0,
    };
  });
}

export async function runRollout(
  opts: OrchOptions,
  flag: FlagSetup,
  recommendation: AnalystRecommendation,
  log: EventLog,
  http = new FlagsmithHttp({
    baseUrl: opts.adminApiUrl || opts.apiUrl,
    token: opts.adminToken,
  }),
): Promise<RolloutResult> {
  log.emit("rollout", "start", "Complete experiment and roll the winning arm to 100%");
  if (recommendation.kind !== "winner") {
    throw new Error("Refusing to roll out without a winner (keep collecting).");
  }
  if (!opts.environmentKey) {
    throw new Error("FLAGSMITH_ENVIRONMENT_KEY is required to complete the experiment");
  }
  const body = completeBody(recommendation.arm, flag.controlKey, flag.variants);
  await http.post(`/environments/${opts.environmentKey}/experiments/${flag.experimentId}/complete/`, body);

  const cleaned: string[] = [];
  const winnerOption = flag.variants.find((item) => item.key === recommendation.arm);
  const { data: states } = await http.get<unknown>(
    `/environments/${opts.environmentKey}/featurestates/?feature=${flag.flagId}`,
  );
  const state = pickEnvDefaultFeatureState(
    listResults<{
      id: number;
      identity?: unknown;
      feature_segment?: unknown;
      multivariate_feature_state_values?: Array<{
        id?: number;
        multivariate_feature_option: number | { id: number };
        percentage_allocation: number;
      }>;
    }>(states),
  );
  const mv = winnerAllocations(state.multivariate_feature_state_values ?? [], winnerOption?.optionId);
  const patchBodies = [
    {
      enabled: true,
      feature_state_value: { type: "unicode", value: recommendation.arm },
      multivariate_feature_state_values: mv,
    },
    {
      enabled: true,
      feature_state_value: { type: "string", value: recommendation.arm },
      multivariate_feature_state_values: mv,
    },
    {
      enabled: true,
      multivariate_feature_state_values: mv,
    },
  ];
  let patched = false;
  let lastPatchError: unknown;
  for (const body of patchBodies) {
    try {
      await http.patch(`/features/featurestates/${state.id}/`, body);
      patched = true;
      break;
    } catch (err) {
      lastPatchError = err;
    }
  }
  if (!patched) {
    throw lastPatchError instanceof Error
      ? lastPatchError
      : new Error("Failed to set environment-default winner to 100%");
  }

  if (opts.projectId) {
    for (const variant of flag.variants) {
      if (variant.key === recommendation.arm) continue;
      try {
        await http.delete(`/projects/${opts.projectId}/features/${flag.flagId}/mv-options/${variant.optionId}/`);
        cleaned.push(variant.key);
      } catch {
        log.emit("rollout", "warn", `Could not delete losing variant ${variant.key}; left at 0%`);
      }
    }
  }

  log.emit(
    "rollout",
    "done",
    `Experiment ${flag.experimentId} completed. Winner ${recommendation.arm} at 100%. Cleaned ${cleaned.length} losing variants.`,
    {
      experimentId: flag.experimentId,
      winner: recommendation.arm,
      cleaned,
    },
  );
  return {
    completed: true,
    winner: recommendation.arm,
    experimentId: flag.experimentId,
    cleaned,
  };
}
