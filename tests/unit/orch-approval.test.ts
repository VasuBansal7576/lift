import { describe, expect, it } from "vitest";
import { stdout } from "node:process";
import {
  APPROVAL_PHASE,
  KEEP_COLLECTING_PHASE,
  RECORDING_STANDIN_LINE,
  approvalSummary,
  assertApproveArgs,
  requireTypedApproval,
} from "../../orchestrator/src/agents/approval.ts";
import { EventLog } from "../../orchestrator/src/log.ts";
import { pauseForHumanApproval } from "../../orchestrator/src/agents/approval.ts";

describe("human approval gate", () => {
  it("pauses at WAITING_FOR_HUMAN_APPROVAL", () => {
    const log = new EventLog(false);
    const paused = pauseForHumanApproval(log, {
      generation: 1,
      passed: [],
      rejected: [],
    });
    expect(paused.phase).toBe(APPROVAL_PHASE);
    expect(paused.summary).toMatch(/--approve/);
    expect(log.phase).toBe("WAITING_FOR_HUMAN_APPROVAL");
  });

  it("uses KEEP_COLLECTING when Flagsmith is still below the threshold", () => {
    const log = new EventLog(false);
    const paused = pauseForHumanApproval(log, {
      generation: 1,
      passed: [],
      rejected: [],
      recommendation: {
        kind: "keep_collecting",
        threshold: 0.95,
        arms: [],
        source: "flagsmith",
        chanceToWin: 0.91,
        leading: "full-v1",
        reason: "chance_to_win 0.910 < 0.95. Keep collecting.",
      },
    });
    expect(paused.phase).toBe(KEEP_COLLECTING_PHASE);
    expect(log.phase).toBe("KEEP_COLLECTING");
  });

  it("refuses rollout without --approve <id>", () => {
    expect(() => assertApproveArgs(false, null)).toThrow(/--approve/);
    expect(() => assertApproveArgs(true, null)).toThrow(/experiment id/);
  });

  it("accepts APPROVE <id> from a TTY and rejects a mismatch or non-TTY", async () => {
    await requireTypedApproval(12, {
      isTTY: true,
      readLine: async () => "APPROVE 12",
    });
    await expect(
      requireTypedApproval(12, { isTTY: true, readLine: async () => "yes" }),
    ).rejects.toThrow(/did not match/);
    await expect(
      requireTypedApproval(12, { isTTY: false, readLine: async () => "APPROVE 12" }),
    ).rejects.toThrow(/TTY/);
  });

  it("prints the recording stand-in disclosure after a matching APPROVE", async () => {
    const previous = process.env.LIFT_RECORDING_STANDIN;
    process.env.LIFT_RECORDING_STANDIN = "1";
    const chunks: string[] = [];
    const orig = stdout.write.bind(stdout);
    stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof stdout.write;
    try {
      await requireTypedApproval(12, { isTTY: true, readLine: async () => "APPROVE 12" });
      expect(chunks.join("")).toContain(RECORDING_STANDIN_LINE);
    } finally {
      stdout.write = orig;
      if (previous === undefined) delete process.env.LIFT_RECORDING_STANDIN;
      else process.env.LIFT_RECORDING_STANDIN = previous;
    }
  });

  it("summarises flag and experiment ids", () => {
    const text = approvalSummary({
      generation: 1,
      passed: [{ specId: "full-v1" } as never],
      rejected: [{ specId: "bad-contrast-v1" } as never],
      flag: {
        dryRun: false,
        flagName: "lift_orch_checkout",
        flagId: 9,
        metricId: 3,
        metricEvent: "checkout_completed",
        experimentId: 12,
        experimentName: "demo",
        variants: [],
        controlKey: "control",
        dashboardUrl: "http://127.0.0.1:8000",
        usedCli: true,
      },
      recommendation: {
        kind: "winner",
        arm: "full-v1",
        chanceToWin: 0.99,
        threshold: 0.95,
        arms: [],
        source: "flagsmith",
      },
    });
    expect(text).toMatch(/experiment id=12/);
    expect(text).toMatch(/full-v1/);
    expect(text).toMatch(/APPROVE/);
  });
});
