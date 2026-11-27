import type { EventLog } from "../log.ts";
import type { AnalystRecommendation, ArmChance } from "../types.ts";

export const DEFAULT_WIN_THRESHOLD = 0.95;

export interface FlagsmithResultsLike {
  results?: {
    as_of?: string | null;
    payload?: {
      metrics?: Array<{
        variants?: Record<string, { n?: number; sum?: number }>;
        inference?: Record<string, { chance_to_win?: number; lift?: number | null } | null>;
      }>;
    } | null;
  } | null;
}

export function parseArmChances(envelope: FlagsmithResultsLike | null): ArmChance[] {
  const metric = envelope?.results?.payload?.metrics?.[0];
  const inference = metric?.inference;
  if (!inference) return [];
  const variants = metric?.variants ?? {};
  const arms: ArmChance[] = [];
  for (const [key, value] of Object.entries(inference)) {
    if (!value || typeof value.chance_to_win !== "number") continue;
    arms.push({
      key,
      chanceToWin: value.chance_to_win,
      n: variants[key]?.n ?? null,
      sum: variants[key]?.sum ?? null,
      lift: typeof value.lift === "number" ? value.lift : null,
    });
  }
  return arms.sort((a, b) => b.chanceToWin - a.chanceToWin);
}

export function recommendWinner(
  arms: ArmChance[],
  threshold = DEFAULT_WIN_THRESHOLD,
  source: "flagsmith" | "none" = arms.length ? "flagsmith" : "none",
): AnalystRecommendation {
  if (arms.length === 0) {
    return {
      kind: "keep_collecting",
      threshold,
      arms,
      source,
      reason: "No chance_to_win yet. Keep collecting.",
    };
  }
  const best = arms[0];
  if (best.chanceToWin >= threshold) {
    return {
      kind: "winner",
      arm: best.key,
      chanceToWin: best.chanceToWin,
      threshold,
      arms,
      source,
    };
  }
  return {
    kind: "keep_collecting",
    leading: best.key,
    chanceToWin: best.chanceToWin,
    threshold,
    arms,
    source,
    reason: `chance_to_win ${best.chanceToWin.toFixed(3)} < ${threshold.toFixed(2)}. Keep collecting.`,
  };
}

export function runAnalyst(
  envelope: FlagsmithResultsLike | null,
  log: EventLog,
  threshold = DEFAULT_WIN_THRESHOLD,
): AnalystRecommendation {
  log.emit("analyst", "start", `Read experiment results (threshold ${threshold})`);
  const arms = parseArmChances(envelope);
  const recommendation = recommendWinner(arms, threshold, arms.length ? "flagsmith" : "none");
  if (recommendation.kind === "winner") {
    log.emit("analyst", "done", `Recommend ${recommendation.arm} (chance_to_win=${recommendation.chanceToWin.toFixed(3)})`, {
      arm: recommendation.arm,
      chanceToWin: recommendation.chanceToWin,
      threshold,
    });
  } else {
    log.emit("analyst", "wait", recommendation.reason, {
      leading: recommendation.leading,
      chanceToWin: recommendation.chanceToWin,
      threshold,
    });
  }
  return recommendation;
}
