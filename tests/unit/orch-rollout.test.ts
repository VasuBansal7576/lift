import { describe, expect, it } from "vitest";
import { runRollout } from "../../orchestrator/src/agents/rollout.ts";
import { EventLog } from "../../orchestrator/src/log.ts";
import { FlagsmithHttp } from "../../orchestrator/src/flagsmith/http.ts";
import type { FlagSetup, OrchOptions } from "../../orchestrator/src/types.ts";

const options: OrchOptions = {
  apply: true,
  approve: true,
  allowRemote: false,
  generations: 1,
  siteUrl: "http://127.0.0.1:4174/checkout",
  uiPort: 4177,
  trafficN: 8,
  threshold: 0.95,
  flagName: "checkout_orch_a11y",
  metricEvent: "checkout_completed",
  keepUi: false,
  noUi: true,
  resultsWaitMs: 1,
  apiUrl: "http://127.0.0.1:8000/api/v1/",
  adminApiUrl: "http://127.0.0.1:8000/api/v1/",
  eventsUrl: "http://127.0.0.1:8000/api/",
  dashboardUrl: "http://127.0.0.1:8000",
  environmentKey: "envkey",
  serverKey: "serverkey",
  adminToken: "admin-token",
  projectId: "1",
  organisationId: "1",
  environmentId: "1",
};

const flag: FlagSetup = {
  dryRun: false,
  flagName: "checkout_orch_a11y",
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

describe("rollout agent", () => {
  it("completes the experiment and deletes losing variants", async () => {
    const calls: string[] = [];
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
        if (url.includes("/featurestates/")) {
          return {
            status: 200,
            text: async () =>
              JSON.stringify({
                results: [
                  {
                    id: 77,
                    multivariate_feature_state_values: [
                      { id: 1, multivariate_feature_option: 22, percentage_allocation: 50 },
                      { id: 2, multivariate_feature_option: 23, percentage_allocation: 50 },
                    ],
                  },
                ],
              }),
          };
        }
        return { status: 200, text: async () => "{}" };
      },
    });
    const log = new EventLog(false);
    const result = await runRollout(
      options,
      flag,
      {
        kind: "winner",
        arm: "full-v1",
        chanceToWin: 0.99,
        threshold: 0.95,
        arms: [],
        source: "flagsmith",
      },
      log,
      http,
    );
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
