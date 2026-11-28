import {
  floorsMet,
  parseFlagsmithWin,
  type FlagsmithResultsEnvelope,
} from "../../agent/src/decide.ts";

/** Same 95% bar Lift uses for Flagsmith chance_to_win. */
export const CHANCE_TO_WIN_THRESHOLD = 0.95;

export type RolloutDecision = "rollout_treatment" | "pull_to_control";

export interface RolloutPick {
  ok: boolean;
  decision?: RolloutDecision;
  winner?: string;
  chanceToWin?: number;
  chances: Record<string, number>;
  reason?: string;
  collecting?: boolean;
  usable?: boolean;
}

export function asResultsEnvelope(raw: unknown): FlagsmithResultsEnvelope | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.results && typeof obj.results === "object") {
    return raw as FlagsmithResultsEnvelope;
  }
  if (obj.payload && typeof obj.payload === "object") {
    return { results: obj } as FlagsmithResultsEnvelope;
  }
  if (Array.isArray(obj.metrics) || obj.inference) {
    return { results: { payload: obj } } as FlagsmithResultsEnvelope;
  }
  return raw as FlagsmithResultsEnvelope;
}

export function chanceByArm(envelope: FlagsmithResultsEnvelope | null): Record<string, number> {
  const inference = envelope?.results?.payload?.metrics?.[0]?.inference ?? {};
  const chances: Record<string, number> = {};
  for (const [key, inf] of Object.entries(inference)) {
    const chance = inf?.chance_to_win;
    if (typeof chance === "number" && Number.isFinite(chance)) {
      chances[key] = chance;
    }
  }
  return chances;
}

export function resultsPresent(raw: unknown): boolean {
  const chances = chanceByArm(asResultsEnvelope(raw));
  return Object.keys(chances).length > 0;
}

function decisionForWinner(winner: string): RolloutDecision | { ok: false; reason: string } {
  if (winner === "control") return "pull_to_control";
  if (winner === "treatment") return "rollout_treatment";
  return { ok: false, reason: `unknown winner key "${winner}"` };
}

/**
 * Pick the arm with the highest Flagsmith chance_to_win.
 * Refuses missing results, a missing arm, still-collecting data, unknown keys,
 * or a winner below the threshold.
 */
export function pickRolloutFromResults(
  raw: unknown,
  threshold = CHANCE_TO_WIN_THRESHOLD,
): RolloutPick {
  const envelope = asResultsEnvelope(raw);
  if (!envelope) {
    return { ok: false, chances: {}, reason: "Results payload missing" };
  }
  const parsed = parseFlagsmithWin(envelope, { localN: 0 });
  if (parsed?.rejectReason === "error") {
    return {
      ok: false,
      chances: chanceByArm(envelope),
      usable: false,
      reason: "Results payload has last_error_at",
    };
  }
  const variants = envelope.results?.payload?.metrics?.[0]?.variants ?? {};
  if (!variants.control || !variants.treatment) {
    return {
      ok: false,
      chances: chanceByArm(envelope),
      usable: parsed?.usable ?? false,
      reason: "results missing control or treatment arm; refusing to derive chance_to_win",
    };
  }
  const collecting = !floorsMet([], envelope);
  if (collecting) {
    return {
      ok: false,
      chances: chanceByArm(envelope),
      collecting: true,
      usable: parsed?.usable ?? false,
      reason: "Results still collecting data (need ≥50 identities and ≥5 conversions per arm)",
    };
  }
  const chances = chanceByArm(envelope);
  const entries = Object.entries(chances);
  if (entries.length === 0) {
    return {
      ok: false,
      chances,
      usable: parsed?.usable ?? false,
      reason: "No chance_to_win values on GET .../experiments/{id}/results/",
    };
  }
  entries.sort((a, b) => b[1] - a[1]);
  const [winner, chanceToWin] = entries[0]!;
  const decided = decisionForWinner(winner);
  if (typeof decided === "object") {
    return { ok: false, winner, chanceToWin, chances, reason: decided.reason };
  }
  if (chanceToWin < threshold) {
    return {
      ok: false,
      winner,
      chanceToWin,
      chances,
      usable: parsed?.usable ?? false,
      reason: `Winner ${winner} chance_to_win=${chanceToWin} is below threshold ${threshold}`,
    };
  }
  return {
    ok: true,
    decision: decided,
    winner,
    chanceToWin,
    chances,
    collecting: false,
    usable: parsed?.usable ?? true,
  };
}
