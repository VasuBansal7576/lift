import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { EventLog } from "../log.ts";
import type { AnalystRecommendation, FlagSetup, GateResult, Phase } from "../types.ts";
import { assertNever } from "../types.ts";

export const APPROVAL_PHASE: Phase = "WAITING_FOR_HUMAN_APPROVAL";
export const KEEP_COLLECTING_PHASE: Phase = "KEEP_COLLECTING";

export interface ApprovalIo {
  isTTY: boolean;
  readLine: () => Promise<string>;
}

export function defaultApprovalIo(): ApprovalIo {
  return {
    isTTY: Boolean(stdin.isTTY),
    readLine: async () => {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      try {
        return await rl.question("");
      } finally {
        rl.close();
      }
    },
  };
}

export function approvalPhrase(experimentId: number): string {
  return `APPROVE ${experimentId}`;
}

export const RECORDING_STANDIN_LINE =
  "approved by: recording harness (stand-in for the human approver)";

export async function requireTypedApproval(
  experimentId: number,
  io: ApprovalIo = defaultApprovalIo(),
): Promise<void> {
  if (!Number.isInteger(experimentId) || experimentId <= 0) {
    throw new Error("--approve requires a positive experiment id");
  }
  if (!io.isTTY) {
    throw new Error("Approval requires an interactive TTY. Type APPROVE <experimentId> on a terminal.");
  }
  const expected = approvalPhrase(experimentId);
  if (process.env.LIFT_RECORDING_STANDIN === "1") {
    stdout.write(`${RECORDING_STANDIN_LINE}\n`);
  }
  stdout.write(`Type ${expected} to roll out the winner:\n`);
  const line = (await io.readLine()).trim();
  if (line !== expected) {
    throw new Error(`Approval phrase did not match (expected ${expected}).`);
  }
}

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
    "Rollout happens only on a second invocation with --approve <experimentId> plus a typed APPROVE <id> on a TTY.",
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
  const phase: Phase =
    input.recommendation?.kind === "keep_collecting" ? KEEP_COLLECTING_PHASE : APPROVAL_PHASE;
  log.setPhase(phase);
  log.emit("approval", "wait", summary, {
    phase,
    generation: input.generation,
    passed: input.passed.map((item) => item.specId),
    rejected: input.rejected.map((item) => item.specId),
    recommendation: input.recommendation,
    flagId: input.flag?.flagId,
    experimentId: input.flag?.experimentId,
  });
  return { phase, summary };
}

export function assertApproveArgs(approve: boolean, experimentId: number | null): void {
  if (!approve) {
    throw new Error("Rollout requires --approve <experimentId> plus a typed APPROVE <id> on a TTY.");
  }
  if (!experimentId || !Number.isInteger(experimentId) || experimentId <= 0) {
    throw new Error("--approve requires a positive experiment id, e.g. --approve 12");
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
