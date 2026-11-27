import { describe, expect, it } from "vitest";
import { runFlagAgent } from "../../orchestrator/src/agents/flag.ts";
import { EventLog } from "../../orchestrator/src/log.ts";
import { FlagsmithHttp } from "../../orchestrator/src/flagsmith/http.ts";
import type { GateResult, OrchOptions } from "../../orchestrator/src/types.ts";
import { labelsSpec } from "../../orchestrator/src/agents/mutator.ts";

function opts(apply: boolean): OrchOptions {
  return {
    apply,
    approve: false,
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
    resultsWaitMs: 1000,
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
}

const passed: GateResult[] = [
  {
    specId: "labels-v1",
    title: "labels",
    kind: "template",
    spec: labelsSpec(),
    apply: { ok: true },
    baseline: {
      url: "http://127.0.0.1:4174/checkout",
      violationCount: 3,
      nodeCount: 6,
      ruleIds: ["label"],
      violations: [],
    },
    after: {
      url: "http://127.0.0.1:4174/checkout",
      violationCount: 1,
      nodeCount: 1,
      ruleIds: ["region"],
      violations: [],
    },
    passed: true,
    reason: "ok",
  },
];

function mockFetch() {
  const calls: string[] = [];
  const fetchImpl: ConstructorParameters<typeof FlagsmithHttp>[0]["fetch"] = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    expect(init.headers.Authorization).toMatch(/^Api-Key /);
    const body = (data: unknown, status = 200) => ({
      status,
      text: async () => JSON.stringify(data),
    });
    if (url.includes("/features/?search=")) return body({ results: [] });
    if (url.endsWith("/features/") && init.method === "POST") {
      return body({ id: 11, name: "checkout_orch_a11y", multivariate_options: [] });
    }
    if (url.includes("/mv-options/") && init.method === "GET") return body({ results: [] });
    if (url.includes("/mv-options/") && init.method === "POST") {
      return body({ id: 22, key: "labels-v1" });
    }
    if (url.includes("/experiment-metrics/") && init.method === "GET") return body({ results: [] });
    if (url.includes("/experiment-metrics/") && init.method === "POST") {
      return body({ id: 33, name: "Checkout completed", definition: { event: "checkout_completed" } });
    }
    if (url.includes("/experiments/") && url.includes("start")) {
      return body({ id: 44, name: "exp", status: "running" });
    }
    if (url.includes("/experiments/?q=")) return body({ results: [] });
    if (url.endsWith("/experiments/") && init.method === "POST") {
      return body({ id: 44, name: "exp", status: "draft" });
    }
    return body({ detail: "unhandled" }, 404);
  };
  return { calls, fetchImpl };
}

describe("flag agent", () => {
  it("dry-run does not call Flagsmith", async () => {
    const log = new EventLog(false);
    const { fetchImpl } = mockFetch();
    const http = new FlagsmithHttp({
      baseUrl: "http://127.0.0.1:8000/api/v1/",
      token: "admin-token",
      fetch: fetchImpl,
    });
    const setup = await runFlagAgent(opts(false), passed, 1, "control", log, {
      http,
      runCli: async () => ({ code: 127, stdout: "", stderr: "no" }),
    });
    expect(setup.dryRun).toBe(true);
    expect(setup.experimentId).toBe(0);
    expect(setup.variants[0]?.specId).toBe("labels-v1");
  });

  it("creates flag, metric, and experiment over mocked HTTP", async () => {
    const log = new EventLog(false);
    const { calls, fetchImpl } = mockFetch();
    const http = new FlagsmithHttp({
      baseUrl: "http://127.0.0.1:8000/api/v1/",
      token: "admin-token",
      fetch: fetchImpl,
    });
    const setup = await runFlagAgent(opts(true), passed, 1, "control", log, {
      http,
      runCli: async () => ({ code: 127, stdout: "", stderr: "cli missing" }),
    });
    expect(setup.dryRun).toBe(false);
    expect(setup.flagId).toBe(11);
    expect(setup.metricId).toBe(33);
    expect(setup.experimentId).toBe(44);
    expect(setup.variants[0]?.optionId).toBe(22);
    expect(setup.dashboardUrl).toContain("/environment/1/experiments/44");
    expect(setup.dashboardUrl).not.toContain("envkey");
    expect(calls.some((line) => line.includes("experiment-metrics"))).toBe(true);
    expect(calls.some((line) => line.includes("/experiments/"))).toBe(true);
    expect(JSON.stringify(calls)).not.toMatch(/admin-token/);
  });
});
