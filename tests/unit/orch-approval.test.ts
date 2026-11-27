import { describe, expect, it } from "vitest";
import {
  APPROVAL_PHASE,
  approvalSummary,
  assertCanApprove,
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

  it("refuses rollout without --approve", () => {
    expect(() => assertCanApprove(APPROVAL_PHASE, false)).toThrow(/--approve/);
  });

  it("refuses approve from any other phase", () => {
    expect(() => assertCanApprove("gating", true)).toThrow(/expected WAITING_FOR_HUMAN_APPROVAL/);
  });

  it("summarises flag and experiment ids", () => {
    const text = approvalSummary({
      generation: 1,
      passed: [{ specId: "full-v1" } as never],
      rejected: [{ specId: "bad-contrast-v1" } as never],
      flag: {
        dryRun: false,
        flagName: "checkout_orch_a11y",
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
  });
});
