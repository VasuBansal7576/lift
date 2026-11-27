import { describe, expect, it } from "vitest";
import {
  allocationsAreWinner,
  completeBody,
  pickEnvDefaultFeatureState,
  runRollout,
} from "../../orchestrator/src/agents/rollout.ts";
import { EventLog } from "../../orchestrator/src/log.ts";
import { FlagsmithHttp } from "../../orchestrator/src/flagsmith/http.ts";
import type { FlagSetup } from "../../orchestrator/src/types.ts";
import { testOrchOptions } from "./orch-opts.ts";

const options = testOrchOptions({ apply: true, approve: true, approveExperimentId: 44 });

const flag: FlagSetup = {
  dryRun: false,
  flagName: "lift_orch_checkout",
  flagId: 11,
  metricId: 33,
  metricEvent: "checkout_completed",
  experimentId: 44,
  experimentName: "demo",
  controlKey: "control",
  dashboardUrl: "http://127.0.0.1:8000",
  usedCli: false,
  variants: [
    { key: "full-v1", specId: "full-v1", optionId: 22, title: "full" },
    { key: "labels-v1", specId: "labels-v1", optionId: 23, title: "labels" },
  ],
};

const winner = {
  kind: "winner" as const,
  arm: "full-v1",
  chanceToWin: 0.99,
  threshold: 0.95,
  arms: [],
  source: "flagsmith" as const,
};

function envDefault(allocations: Array<{ option: number; pct: number }>) {
  return {
    results: [
      {
        id: 77,
        identity: null,
        feature_segment: null,
        multivariate_feature_state_values: allocations.map((row, i) => ({
          id: i + 1,
          multivariate_feature_option: row.option,
          percentage_allocation: row.pct,
        })),
      },
    ],
  };
}

describe("rollout agent", () => {
  it("throws on an unknown arm", () => {
    expect(() => completeBody("ghost-v1", "control", flag.variants)).toThrow(/unknown rollout arm/i);
  });

  it("picks the env-default featurestate and asserts 100/0", async () => {
    const patchBodies: unknown[] = [];
    let gets = 0;
    const http = new FlagsmithHttp({
      baseUrl: "http://127.0.0.1:8000/api/v1/",
      token: "admin-token",
      fetch: async (url, init) => {
        if (url.includes("/complete/")) {
          return { status: 200, text: async () => "{}" };
        }
        if (url.includes("/featurestates/") && init.method === "GET") {
          gets += 1;
          const body = gets === 1 ? envDefault([{ option: 22, pct: 50 }, { option: 23, pct: 50 }]) : envDefault([{ option: 22, pct: 100 }, { option: 23, pct: 0 }]);
          return { status: 200, text: async () => JSON.stringify(body) };
        }
        if (url.includes("/featurestates/77/") && init.method === "PATCH") {
          const parsed = JSON.parse(init.body ?? "{}") as {
            feature_state_value?: unknown;
            multivariate_feature_state_values: Array<{ percentage_allocation: number; multivariate_feature_option: number }>;
          };
          expect(parsed.feature_state_value).toBeUndefined();
          patchBodies.push(parsed);
          return { status: 200, text: async () => "{}" };
        }
        return { status: 200, text: async () => "{}" };
      },
    });
    const log = new EventLog(false);
    const result = await runRollout(options, flag, winner, log, http);
    expect(result.winner).toBe("full-v1");
    expect(
      pickEnvDefaultFeatureState([
        { identity: 1, feature_segment: null, id: 1 },
        { identity: null, feature_segment: null, id: 77 },
      ]).id,
    ).toBe(77);
    const mv = (
      patchBodies[0] as {
        multivariate_feature_state_values: Array<{ percentage_allocation: number; multivariate_feature_option: number }>;
      }
    ).multivariate_feature_state_values;
    expect(mv.find((row) => row.multivariate_feature_option === 22)?.percentage_allocation).toBe(100);
    expect(mv.find((row) => row.multivariate_feature_option === 23)?.percentage_allocation).toBe(0);
  });

  it("skips PATCH when complete() already set 100/0", async () => {
    const methods: string[] = [];
    const http = new FlagsmithHttp({
      baseUrl: "http://127.0.0.1:8000/api/v1/",
      token: "admin-token",
      fetch: async (url, init) => {
        methods.push(`${init.method} ${url}`);
        if (url.includes("/complete/")) return { status: 200, text: async () => "{}" };
        if (url.includes("/featurestates/") && init.method === "GET") {
          return {
            status: 200,
            text: async () => JSON.stringify(envDefault([{ option: 22, pct: 100 }, { option: 23, pct: 0 }])),
          };
        }
        if (init.method === "PATCH") {
          return { status: 500, text: async () => "<h1>Server Error (500)</h1>" };
        }
        return { status: 200, text: async () => "{}" };
      },
    });
    const log = new EventLog(false);
    const result = await runRollout(options, flag, winner, log, http);
    expect(result.winner).toBe("full-v1");
    expect(methods.some((line) => line.startsWith("PATCH "))).toBe(false);
  });

  it("continues when PATCH 500s but complete() already rolled 100/0", async () => {
    let gets = 0;
    const http = new FlagsmithHttp({
      baseUrl: "http://127.0.0.1:8000/api/v1/",
      token: "admin-token",
      fetch: async (url, init) => {
        if (url.includes("/complete/")) return { status: 200, text: async () => "{}" };
        if (url.includes("/featurestates/") && init.method === "GET") {
          gets += 1;
          const first = envDefault([{ option: 22, pct: 50 }, { option: 23, pct: 50 }]);
          const done = envDefault([{ option: 22, pct: 100 }, { option: 23, pct: 0 }]);
          return { status: 200, text: async () => JSON.stringify(gets === 1 ? first : done) };
        }
        if (init.method === "PATCH") {
          return { status: 500, text: async () => "<h1>Server Error (500)</h1>" };
        }
        return { status: 200, text: async () => "{}" };
      },
    });
    const log = new EventLog(false);
    const result = await runRollout(options, flag, winner, log, http);
    expect(result.winner).toBe("full-v1");
    expect(allocationsAreWinner([{ multivariate_feature_option: 22, percentage_allocation: 100 }, { multivariate_feature_option: 23, percentage_allocation: 0 }], 22)).toBe(true);
    expect(allocationsAreWinner([{ multivariate_feature_option: 22, percentage_allocation: 50 }, { multivariate_feature_option: 23, percentage_allocation: 50 }], 22)).toBe(false);
  });

  it("completes the experiment and deletes losing variants", async () => {
    const calls: string[] = [];
    let gets = 0;
    const http = new FlagsmithHttp({
      baseUrl: "http://127.0.0.1:8000/api/v1/",
      token: "admin-token",
      fetch: async (url, init) => {
        calls.push(`${init.method} ${url}`);
        if (url.includes("/complete/")) {
          expect(JSON.parse(init.body ?? "{}")).toMatchObject({
            rollout_decision: "variant",
            rollout_variant: 22,
          });
          return { status: 200, text: async () => "{}" };
        }
        if (url.includes("/featurestates/") && init.method === "GET") {
          gets += 1;
          const body = gets === 1 ? envDefault([{ option: 22, pct: 50 }, { option: 23, pct: 50 }]) : envDefault([{ option: 22, pct: 100 }, { option: 23, pct: 0 }]);
          return { status: 200, text: async () => JSON.stringify(body) };
        }
        return { status: 200, text: async () => "{}" };
      },
    });
    const log = new EventLog(false);
    const result = await runRollout(options, flag, winner, log, http);
    expect(result.winner).toBe("full-v1");
    expect(result.cleaned).toContain("labels-v1");
    expect(calls.some((line) => line.includes("/complete/"))).toBe(true);
  });

  it("refuses to roll out keep collecting", async () => {
    const log = new EventLog(false);
    await expect(
      runRollout(
        options,
        flag,
        {
          kind: "keep_collecting",
          threshold: 0.95,
          arms: [],
          source: "none",
          reason: "keep collecting",
        },
        log,
      ),
    ).rejects.toThrow(/keep collecting/i);
  });
});
