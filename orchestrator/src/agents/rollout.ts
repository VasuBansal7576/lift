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

export function optionIdOf(
  row: { multivariate_feature_option: number | { id: number } },
): number {
  return typeof row.multivariate_feature_option === "number"
    ? row.multivariate_feature_option
    : row.multivariate_feature_option.id;
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
    const optionId = optionIdOf(row);
    const isWinner = winnerOptionId !== undefined && optionId === winnerOptionId;
    return {
      id: row.id,
      multivariate_feature_option: optionId,
      percentage_allocation: isWinner ? 100 : 0,
    };
  });
}

/** True when the winner option is 100% and every other option is 0%. */
export function allocationsAreWinner(
  rows: Array<{
    multivariate_feature_option: number | { id: number };
    percentage_allocation: number;
  }>,
  winnerOptionId: number | undefined,
): boolean {
  if (winnerOptionId === undefined || rows.length === 0) return false;
  return rows.every((row) => {
    const want = optionIdOf(row) === winnerOptionId ? 100 : 0;
    return Math.abs(row.percentage_allocation - want) < 0.51;
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
  const winnerOptionId = winnerOption?.optionId;
  let current = state.multivariate_feature_state_values ?? [];
  if (!allocationsAreWinner(current, winnerOptionId)) {
    const mv = winnerAllocations(current, winnerOptionId);
    // Do not send feature_state_value: Flagsmith 2.295.2 complete() already
    // rolls the winner, and a typed/string value 500s the env-default PATCH.
    try {
      await http.patch(`/features/featurestates/${state.id}/`, {
        enabled: true,
        multivariate_feature_state_values: mv,
      });
    } catch (err) {
      const { data: retried } = await http.get<unknown>(
        `/environments/${opts.environmentKey}/featurestates/?feature=${flag.flagId}`,
      );
      const again = pickEnvDefaultFeatureState(
        listResults<{
          identity?: unknown;
          feature_segment?: unknown;
          multivariate_feature_state_values?: typeof current;
        }>(retried),
      );
      current = again.multivariate_feature_state_values ?? [];
      if (!allocationsAreWinner(current, winnerOptionId)) {
        throw err instanceof Error ? err : new Error("Failed to set environment-default winner to 100%");
      }
      log.emit("rollout", "warn", "PATCH skipped after complete(): winner already at 100/0");
    }
  } else {
    log.emit("rollout", "info", "complete() already set winner to 100/0; skipping featurestate PATCH");
  }

  const { data: verifiedRaw } = await http.get<unknown>(
    `/environments/${opts.environmentKey}/featurestates/?feature=${flag.flagId}`,
  );
  const verified = pickEnvDefaultFeatureState(
    listResults<{
      identity?: unknown;
      feature_segment?: unknown;
      multivariate_feature_state_values?: typeof current;
    }>(verifiedRaw),
  );
  if (!allocationsAreWinner(verified.multivariate_feature_state_values ?? [], winnerOptionId)) {
    throw new Error(`Winner ${recommendation.arm} is not at 100% on the environment-default featurestate`);
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
