import { describe, expect, it } from "vitest";
import { LiftSelfhost } from "../../selfhost/src/client.ts";
import { parseArgs } from "../../selfhost/src/args.ts";
import { pickRolloutFromResults } from "../../selfhost/src/results.ts";
import { parseApprovalLine } from "../../selfhost/src/approve.ts";
import {
  assertApprovalCommand,
  assertServedVariants,
  canReuseExistingFlag,
  guardApply,
  planOrRefuse,
  rolloutWinner,
  shouldDeleteRecorded,
  startExperimentViaApi,
} from "../../selfhost/src/skill-ops.ts";

function envelope(opts: {
  treatmentChance: number;
  controlChance?: number;
  controlN?: number;
  treatmentN?: number;
  controlSum?: number;
  treatmentSum?: number;
  extraArm?: { key: string; chance: number };
  omitControl?: boolean;
  omitControlVariant?: boolean;
}) {
  const inference: Record<string, { chance_to_win: number }> = {
    treatment: { chance_to_win: opts.treatmentChance },
  };
  if (!opts.omitControl) {
    inference.control = { chance_to_win: opts.controlChance ?? 1 - opts.treatmentChance };
  }
  if (opts.extraArm) inference[opts.extraArm.key] = { chance_to_win: opts.extraArm.chance };
  const variants: Record<string, { n: number; sum: number }> = {
    treatment: { n: opts.treatmentN ?? 60, sum: opts.treatmentSum ?? 40 },
  };
  if (!opts.omitControlVariant) {
    variants.control = { n: opts.controlN ?? 60, sum: opts.controlSum ?? 10 };
  }
  return {
    results: {
      payload: {
        metrics: [
          {
            variants,
            inference,
          },
        ],
      },
    },
  };
}

function lift() {
  return new LiftSelfhost({
    apiUrl: "http://127.0.0.1:8000/api/v1/",
    environmentKey: "env",
    adminToken: "token",
  });
}

const ctx = {
  environmentName: "Development",
  confirmProd: false,
  apply: true,
  apiUrl: "http://127.0.0.1:8000/api/v1/",
  adminApiUrl: "http://127.0.0.1:8000/api/v1/",
  cliApiUrl: "http://127.0.0.1:8000",
  eventsUrl: "http://127.0.0.1:8000/api/",
};

const approvalHooks = {
  getExperiment: async () => ({ id: 7, name: "lift a11y skill", status: "running", feature: 3 }),
  findFeature: async () => ({ id: 3, name: "lift_a11y_skill" }),
  readApprovalLine: async () => ({ ok: true as const, line: "APPROVE 7" }),
};

describe("pickRolloutFromResults", () => {
  it("picks treatment when it has the highest chance_to_win", () => {
    const pick = pickRolloutFromResults(envelope({ treatmentChance: 0.99 }));
    expect(pick.ok).toBe(true);
    expect(pick.winner).toBe("treatment");
    expect(pick.decision).toBe("rollout_treatment");
    expect(pick.chanceToWin).toBe(0.99);
  });

  it("picks control when it has the highest chance_to_win", () => {
    const pick = pickRolloutFromResults(
      envelope({ treatmentChance: 0.02, controlChance: 0.98, controlSum: 40, treatmentSum: 8 }),
    );
    expect(pick.ok).toBe(true);
    expect(pick.winner).toBe("control");
    expect(pick.decision).toBe("pull_to_control");
  });

  it("refuses while still collecting data", () => {
    const pick = pickRolloutFromResults(
      envelope({ treatmentChance: 0.99, controlN: 10, treatmentN: 12, controlSum: 1, treatmentSum: 2 }),
    );
    expect(pick.ok).toBe(false);
    expect(pick.collecting).toBe(true);
  });

  it("refuses missing results", () => {
    expect(pickRolloutFromResults(null).ok).toBe(false);
    expect(pickRolloutFromResults({ results: { payload: { metrics: [] } } }).ok).toBe(false);
  });

  it("refuses when an arm is missing rather than deriving chance_to_win", () => {
    const pick = pickRolloutFromResults(
      envelope({ treatmentChance: 0.99, omitControlVariant: true, omitControl: true }),
    );
    expect(pick.ok).toBe(false);
    expect(pick.reason).toMatch(/missing control or treatment arm/);
  });

  it("picks treatment when Flagsmith omits control chance_to_win but both variant arms exist", () => {
    const pick = pickRolloutFromResults(envelope({ treatmentChance: 0.99, omitControl: true }));
    expect(pick.ok).toBe(true);
    expect(pick.winner).toBe("treatment");
    expect(pick.chances.control).toBeUndefined();
  });

  it("fails on unknown winner keys", () => {
    const pick = pickRolloutFromResults(
      envelope({ treatmentChance: 0.01, controlChance: 0.02, extraArm: { key: "other", chance: 0.99 } }),
    );
    expect(pick.ok).toBe(false);
    expect(pick.winner).toBe("other");
    expect(pick.reason).toMatch(/unknown winner key/);
  });
});

describe("rolloutWinner chance_to_win", () => {
  it("pins treatment on a treatment win after complete succeeds", async () => {
    const pinCalls: number[] = [];
    const completeCalls: unknown[] = [];
    const out = await rolloutWinner(
      lift(),
      ctx,
      { flagName: "lift_a11y_skill", experimentId: 7, treatmentOptionId: 9 },
      {
        ...approvalHooks,
        fetchResults: async () => envelope({ treatmentChance: 0.99 }),
        complete: async (_id, body) => {
          completeCalls.push(body);
        },
        pinTreatment: async (_flag, percent) => {
          pinCalls.push(percent);
          return { via: "cli", percent };
        },
      },
    );
    expect(out.ok).toBe(true);
    expect(completeCalls[0]).toEqual({ rollout_decision: "variant", rollout_variant: 9 });
    expect(pinCalls).toEqual([100]);
  });

  it("keeps control on a control win and does not pin treatment", async () => {
    const pinCalls: number[] = [];
    const out = await rolloutWinner(
      lift(),
      ctx,
      { flagName: "lift_a11y_skill", experimentId: 7, treatmentOptionId: 9 },
      {
        ...approvalHooks,
        fetchResults: async () =>
          envelope({
            treatmentChance: 0.01,
            controlChance: 0.99,
            controlSum: 40,
            treatmentSum: 8,
          }),
        complete: async () => ({}),
        pinTreatment: async (_flag, percent) => {
          pinCalls.push(percent);
          return { via: "cli", percent };
        },
      },
    );
    expect(out.ok).toBe(true);
    expect((out as { pick?: { winner?: string } }).pick?.winner).toBe("control");
    expect(pinCalls).toEqual([0]);
  });

  it("refuses insufficient data and does not complete or pin", async () => {
    const completeCalls: unknown[] = [];
    const pinCalls: number[] = [];
    const out = await rolloutWinner(
      lift(),
      ctx,
      { flagName: "lift_a11y_skill", experimentId: 7, treatmentOptionId: 9 },
      {
        ...approvalHooks,
        fetchResults: async () =>
          envelope({
            treatmentChance: 0.99,
            controlN: 8,
            treatmentN: 9,
            controlSum: 1,
            treatmentSum: 2,
          }),
        complete: async (_id, body) => {
          completeCalls.push(body);
        },
        pinTreatment: async (_flag, percent) => {
          pinCalls.push(percent);
        },
      },
    );
    expect(out.ok).toBe(false);
    expect(completeCalls).toEqual([]);
    expect(pinCalls).toEqual([]);
  });

  it("does not pin if complete/ fails", async () => {
    const pinCalls: number[] = [];
    const out = await rolloutWinner(
      lift(),
      ctx,
      { flagName: "lift_a11y_skill", experimentId: 7, treatmentOptionId: 9 },
      {
        ...approvalHooks,
        fetchResults: async () => envelope({ treatmentChance: 0.99 }),
        complete: async () => {
          throw new Error("complete failed");
        },
        pinTreatment: async (_flag, percent) => {
          pinCalls.push(percent);
        },
      },
    );
    expect(out.ok).toBe(false);
    expect((out as { pinned?: boolean }).pinned).toBe(false);
    expect(pinCalls).toEqual([]);
  });
});

describe("E2 guard before weights", () => {
  it("planOrRefuse is fatal for remote URLs including cli and events", () => {
    const refused = planOrRefuse({
      environmentName: "Development",
      confirmProd: false,
      apply: true,
      apiUrl: "http://127.0.0.1:8000/api/v1/",
      eventsUrl: "https://events.flagsmith.com/",
    });
    expect(refused.ok).toBe(false);
    expect(guardApply({ environmentName: "Development", confirmProd: false, apply: true, apiUrl: "https://api.flagsmith.com/" }).ok).toBe(false);
  });

});

describe("E3 served variant identities", () => {
  it("requires control/treatment variants and the flag name in status", () => {
    expect(
      assertServedVariants({
        flagName: "lift_a11y_skill",
        control: { variant: "control", status: "Flagsmith lift_a11y_skill=control" },
        treatment: { variant: "treatment", status: "Flagsmith lift_a11y_skill=treatment" },
      }).ok,
    ).toBe(true);
    expect(
      assertServedVariants({
        flagName: "lift_a11y_skill",
        control: { variant: "treatment", status: "Flagsmith lift_a11y_skill=treatment" },
        treatment: { variant: "treatment", status: "Flagsmith lift_a11y_skill=treatment" },
      }).ok,
    ).toBe(false);
    expect(
      assertServedVariants({
        flagName: "lift_a11y_skill",
        control: { variant: "control", status: "Flagsmith checkout_a11y=control" },
        treatment: { variant: "treatment", status: "Flagsmith checkout_a11y=treatment" },
      }).ok,
    ).toBe(false);
  });
});

describe("no traffic before the axe gate", () => {
  it("refuses start without a passing gate rather than relying on environment-wide 100%", async () => {
    const out = await startExperimentViaApi(lift(), { ...ctx, gate: null }, 1);
    expect(out.ok).toBe(false);
    expect((out as { code?: string }).code).toBe("AXE_GATE");
  });
});

describe("reuse flag and running experiment gate", () => {
  it("refuses an existing flag not recorded in last-run.json unless --reuse-flag", () => {
    const existing = { name: "lift_a11y_skill", id: 9 };
    expect(canReuseExistingFlag(existing, { recorded: [] }).ok).toBe(false);
    expect(canReuseExistingFlag(existing, { reuseFlag: true }).ok).toBe(true);
    expect(canReuseExistingFlag(existing, { recorded: [{ name: "lift_a11y_skill", id: 9 }] }).ok).toBe(
      true,
    );
    expect(canReuseExistingFlag(existing, { recorded: [{ name: "lift_a11y_skill", id: 1 }] }).ok).toBe(
      false,
    );
    expect(canReuseExistingFlag(null, {}).ok).toBe(true);
  });

});

describe("E6 cleanup name+id only", () => {
  it("deletes only recorded name and id pairs", () => {
    const recorded = [{ name: "lift_a11y_stale_demo", id: 14 }];
    expect(shouldDeleteRecorded({ name: "lift_a11y_stale_demo", id: 14 }, recorded)).toBe(true);
    expect(shouldDeleteRecorded({ name: "lift_a11y_stale_demo", id: 99 }, recorded)).toBe(false);
    expect(shouldDeleteRecorded({ name: "checkout_a11y", id: 1 }, recorded)).toBe(false);
    expect(shouldDeleteRecorded(null, recorded)).toBe(false);
  });

  it("cleanup does not delete a flag that only shares a name prefix", () => {
    const recorded = [{ name: "lift_a11y_stale_demo", id: 14 }];
    expect(shouldDeleteRecorded({ name: "lift_a11y_stale_demo_extra", id: 14 }, recorded)).toBe(false);
    expect(shouldDeleteRecorded({ name: "lift_a11y_r5", id: 14 }, recorded)).toBe(false);
  });
});

describe("E7 approval command", () => {
  it("refuses leftover --approve-rollout", () => {
    expect(assertApprovalCommand(parseArgs(["--approve-rollout", "--start"]).flags).ok).toBe(false);
    expect(assertApprovalCommand(parseArgs(["--approve-rollout", "--apply"]).flags).ok).toBe(false);
  });

  it("requires --experiment-id to approve", async () => {
    const missing = await rolloutWinner(lift(), ctx, { flagName: "lift_a11y_skill" }, approvalHooks);
    expect(missing.ok).toBe(false);
    expect(String((missing as { reason?: string }).reason)).toMatch(/experiment-id/);
  });

  it("accepts exactly APPROVE <id> and rejects empty or wrong id", () => {
    expect(parseApprovalLine("APPROVE 7", 7).ok).toBe(true);
    expect(parseApprovalLine("", 7).ok).toBe(false);
    expect(parseApprovalLine("APPROVE 99", 7).ok).toBe(false);
    expect(parseApprovalLine("approve 7", 7).ok).toBe(false);
  });

  it("refuses when the winner changes after the approval line", async () => {
    let n = 0;
    const out = await rolloutWinner(
      lift(),
      ctx,
      { flagName: "lift_a11y_skill", experimentId: 7, treatmentOptionId: 9 },
      {
        ...approvalHooks,
        fetchResults: async () => {
          n += 1;
          if (n < 3) return envelope({ treatmentChance: 0.99 });
          return envelope({
            treatmentChance: 0.01,
            controlChance: 0.99,
            controlSum: 40,
            treatmentSum: 8,
          });
        },
        complete: async () => ({}),
        pinTreatment: async () => ({}),
      },
    );
    expect(out.ok).toBe(false);
    expect(String((out as { reason?: string }).reason)).toMatch(/winner changed/);
  });

  it("refuses a non-running experiment or one that belongs to another flag", async () => {
    const notRunning = await rolloutWinner(
      lift(),
      ctx,
      { flagName: "lift_a11y_skill", experimentId: 7, treatmentOptionId: 9 },
      {
        getExperiment: async () => ({ id: 7, name: "x", status: "completed", feature: 3 }),
        findFeature: async () => ({ id: 3, name: "lift_a11y_skill" }),
        fetchResults: async () => envelope({ treatmentChance: 0.99 }),
      },
    );
    expect(notRunning.ok).toBe(false);

    const wrongFlag = await rolloutWinner(
      lift(),
      ctx,
      { flagName: "lift_a11y_skill", experimentId: 7, treatmentOptionId: 9 },
      {
        getExperiment: async () => ({ id: 7, name: "x", status: "running", feature: 99 }),
        findFeature: async () => ({ id: 3, name: "lift_a11y_skill" }),
        fetchResults: async () => envelope({ treatmentChance: 0.99 }),
      },
    );
    expect(wrongFlag.ok).toBe(false);

    const noResults = await rolloutWinner(
      lift(),
      ctx,
      { flagName: "lift_a11y_skill", experimentId: 7, treatmentOptionId: 9 },
      {
        getExperiment: async () => ({ id: 7, name: "x", status: "running", feature: 3 }),
        findFeature: async () => ({ id: 3, name: "lift_a11y_skill" }),
        fetchResults: async () => ({ results: { payload: { metrics: [] } } }),
      },
    );
    expect(noResults.ok).toBe(false);
  });
});

describe("startExperimentViaApi gate", () => {
  it("refuses --start without a passing gate from this run", async () => {
    const out = await startExperimentViaApi(lift(), { ...ctx, gate: null }, 1);
    expect(out.ok).toBe(false);
    expect((out as { code?: string }).code).toBe("AXE_GATE");
  });

  it("refuses --start when the gate rejected", async () => {
    const out = await startExperimentViaApi(
      lift(),
      {
        ...ctx,
        gate: {
          ok: false,
          rejected: true,
          reason: "REJECT",
          addedIds: ["label"],
          increased: [],
        },
      },
      1,
    );
    expect(out.ok).toBe(false);
  });
});
