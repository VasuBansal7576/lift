import type { EventLog } from "../log.ts";
import type { AnalystRecommendation, FlagSetup, GateResult, Phase } from "../types.ts";
import { assertNever } from "../types.ts";

export const APPROVAL_PHASE: Phase = "WAITING_FOR_HUMAN_APPROVAL";

export function approvalSummary(input: {
  recommendation?: AnalystRecommendation;
  flag?: FlagSetup;
  passed: GateResult[];
  rejected: GateResult[];
  generation: number;
}): string {
  const rec = input.recommendation;
  const recLine =
    rec?.kind === "winner"
      ? `Recommended winner: ${rec.arm} (chance_to_win=${rec.chanceToWin.toFixed(3)}, threshold=${rec.threshold})`
      : rec
        ? `No rollout yet: ${rec.reason}`
        : "No Flagsmith results in this run.";
  return [
    `Generation ${input.generation}.`,
    `Gate: ${input.passed.length} passed, ${input.rejected.length} rejected.`,
    input.flag
      ? `Flag ${input.flag.flagName} id=${input.flag.flagId}; experiment id=${input.flag.experimentId}; metric id=${input.flag.metricId}.`
      : "No Flagsmith resources (dry-run).",
    recLine,
    "Rollout happens only on a second invocation with --approve.",
  ].join(" ");
}

export function pauseForHumanApproval(
  log: EventLog,
  input: {
    recommendation?: AnalystRecommendation;
    flag?: FlagSetup;
    passed: GateResult[];
    rejected: GateResult[];
    generation: number;
  },
): { phase: Phase; summary: string } {
  const summary = approvalSummary(input);
  log.setPhase(APPROVAL_PHASE);
  log.emit("approval", "wait", summary, {
    phase: APPROVAL_PHASE,
    generation: input.generation,
    passed: input.passed.map((item) => item.specId),
    rejected: input.rejected.map((item) => item.specId),
    recommendation: input.recommendation,
    flagId: input.flag?.flagId,
    experimentId: input.flag?.experimentId,
  });
  return { phase: APPROVAL_PHASE, summary };
}

export function assertCanApprove(phase: Phase, approve: boolean): void {
  if (!approve) {
    throw new Error("Rollout requires an explicit --approve invocation.");
  }
  if (phase !== APPROVAL_PHASE) {
    throw new Error(`Cannot approve from phase ${phase}; expected ${APPROVAL_PHASE}.`);
  }
}

export function describeRecommendation(rec: AnalystRecommendation): string {
  switch (rec.kind) {
    case "winner":
      return `${rec.arm} wins at ${(rec.chanceToWin * 100).toFixed(1)}%`;
    case "keep_collecting":
      return rec.reason;
    default: {
      const _exhaustive: never = rec;
      return assertNever(_exhaustive, "unhandled recommendation");
    }
  }
}
