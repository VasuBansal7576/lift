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

function completeBody(
  winner: string,
  controlKey: string,
  variants: FlagVariantRecord[],
): { rollout_decision: "variant" | "control"; rollout_variant?: number } {
  if (winner === controlKey || winner === "control") {
    return { rollout_decision: "control" };
  }
  const option = variants.find((item) => item.key === winner);
  if (!option) {
    return { rollout_decision: "control" };
  }
  return { rollout_decision: "variant", rollout_variant: option.optionId };
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
  const state = listResults<{
    id: number;
    multivariate_feature_state_values?: Array<{
      id?: number;
      multivariate_feature_option: number | { id: number };
      percentage_allocation: number;
    }>;
  }>(states)[0];
  if (state) {
    const mv = (state.multivariate_feature_state_values ?? []).map((row) => {
      const optionId =
        typeof row.multivariate_feature_option === "number"
          ? row.multivariate_feature_option
          : row.multivariate_feature_option.id;
      const isWinner = winnerOption ? optionId === winnerOption.optionId : false;
      return {
        id: row.id,
        multivariate_feature_option: optionId,
        percentage_allocation: isWinner ? 100 : 0,
      };
    });
    await http.patch(`/features/featurestates/${state.id}/`, {
      enabled: true,
      feature_state_value: recommendation.arm,
      multivariate_feature_state_values: mv,
    });
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
