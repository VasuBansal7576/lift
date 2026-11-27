import { describe, expect, it } from "vitest";
import { DESCRIPTION_MARKER } from "../../orchestrator/src/names.ts";
import { cleanupOrchFlags, runFlagAgent } from "../../orchestrator/src/agents/flag.ts";
import { EventLog } from "../../orchestrator/src/log.ts";
import { FlagsmithHttp } from "../../orchestrator/src/flagsmith/http.ts";
import type { GateResult } from "../../orchestrator/src/types.ts";
import { labelsSpec } from "../../orchestrator/src/agents/mutator.ts";
import { testOrchOptions } from "./orch-opts.ts";

function opts(apply: boolean) {
  return testOrchOptions({ apply });
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
  const bodies: string[] = [];
  const fetchImpl: ConstructorParameters<typeof FlagsmithHttp>[0]["fetch"] = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (init.body) bodies.push(init.body);
    expect(init.headers.Authorization).toMatch(/^Api-Key /);
    const body = (data: unknown, status = 200) => ({
      status,
      text: async () => JSON.stringify(data),
    });
    if (url.includes("/features/?search=")) return body({ results: [] });
    if (url.endsWith("/features/") && init.method === "POST") {
      const payload = JSON.parse(init.body ?? "{}") as { name: string; description: string };
      expect(payload.name.startsWith("lift_orch_")).toBe(true);
      expect(payload.description).toContain(DESCRIPTION_MARKER);
      return body({
        id: 11,
        name: payload.name,
        description: payload.description,
        multivariate_options: [],
      });
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
  return { calls, bodies, fetchImpl };
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
    expect(setup.flagName).toBe("lift_orch_checkout");
    expect(setup.variants[0]?.specId).toBe("labels-v1");
  });

  it("creates flag, metric, and experiment over mocked HTTP with a real env-key dashboard URL", async () => {
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
    expect(setup.dashboardUrl).toContain("/environment/envkey/experiments/44");
    expect(calls.some((line) => line.includes("experiment-metrics"))).toBe(true);
    expect(calls.some((line) => line.includes("/experiments/"))).toBe(true);
    expect(JSON.stringify(calls)).not.toMatch(/admin-token/);
  });

  it("labels gen-2 control as the gen-1 champion in the experiment hypothesis", async () => {
    const log = new EventLog(false);
    const { bodies, fetchImpl } = mockFetch();
    const http = new FlagsmithHttp({
      baseUrl: "http://127.0.0.1:8000/api/v1/",
      token: "admin-token",
      fetch: fetchImpl,
    });
    await runFlagAgent(opts(true), passed, 2, "control", log, {
      http,
      runCli: async () => ({ code: 127, stdout: "", stderr: "cli missing" }),
      championId: "full-v1",
    });
    expect(bodies.join("\n")).toMatch(/Control = gen-1 champion full-v1/);
    expect(log.events.some((event) => /Control = gen-1 champion full-v1/.test(event.message))).toBe(true);
  });

  it("refuses a foreign flag that lacks the orch description marker", async () => {
    const log = new EventLog(false);
    const http = new FlagsmithHttp({
      baseUrl: "http://127.0.0.1:8000/api/v1/",
      token: "admin-token",
      fetch: async (url, init) => {
        if (url.includes("/features/?search=")) {
          return {
            status: 200,
            text: async () =>
              JSON.stringify({ results: [{ id: 9, name: "lift_orch_checkout", description: "not ours" }] }),
          };
        }
        if (url.includes("/features/9/") && init.method === "GET") {
          return {
            status: 200,
            text: async () => JSON.stringify({ id: 9, name: "lift_orch_checkout", description: "not ours" }),
          };
        }
        return { status: 404, text: async () => "{}" };
      },
    });
    await expect(
      runFlagAgent(opts(true), passed, 1, "control", log, {
        http,
        runCli: async () => ({ code: 127, stdout: "", stderr: "cli missing" }),
      }),
    ).rejects.toThrow(/foreign flag/i);
  });

  it("refuses a stale orch flag instead of reusing it", async () => {
    const log = new EventLog(false);
    const http = new FlagsmithHttp({
      baseUrl: "http://127.0.0.1:8000/api/v1/",
      token: "admin-token",
      fetch: async (url, init) => {
        if (url.includes("/features/?search=")) {
          return {
            status: 200,
            text: async () =>
              JSON.stringify({
                results: [{ id: 9, name: "lift_orch_checkout", description: DESCRIPTION_MARKER }],
              }),
          };
        }
        if (url.includes("/features/9/") && init.method === "GET") {
          return {
            status: 200,
            text: async () =>
              JSON.stringify({ id: 9, name: "lift_orch_checkout", description: DESCRIPTION_MARKER }),
          };
        }
        return { status: 404, text: async () => "{}" };
      },
    });
    await expect(
      runFlagAgent(opts(true), passed, 1, "control", log, {
        http,
        runCli: async () => ({ code: 127, stdout: "", stderr: "cli missing" }),
      }),
    ).rejects.toThrow(/stale flag/i);
  });

  it("cleanup only deletes lift_orch_ flags with the orch marker", async () => {
    const deleted: string[] = [];
    const http = new FlagsmithHttp({
      baseUrl: "http://127.0.0.1:8000/api/v1/",
      token: "admin-token",
      fetch: async (url, init) => {
        if (url.endsWith("/features/") && init.method === "GET") {
          return {
            status: 200,
            text: async () =>
              JSON.stringify({
                results: [
                  { id: 1, name: "checkout_a11y", description: "prod" },
                  { id: 2, name: "lift_orch_tmp", description: DESCRIPTION_MARKER },
                  { id: 3, name: "lift_orch_foreign", description: "nope" },
                ],
              }),
          };
        }
        if (url.includes("/features/2/") && init.method === "GET") {
          return {
            status: 200,
            text: async () => JSON.stringify({ id: 2, name: "lift_orch_tmp", description: DESCRIPTION_MARKER }),
          };
        }
        if (url.includes("/features/3/") && init.method === "GET") {
          return {
            status: 200,
            text: async () => JSON.stringify({ id: 3, name: "lift_orch_foreign", description: "nope" }),
          };
        }
        if (url.includes("/features/2/") && init.method === "DELETE") {
          deleted.push("lift_orch_tmp");
          return { status: 204, text: async () => "" };
        }
        if (url.includes("/experiments/")) {
          return { status: 200, text: async () => JSON.stringify({ results: [] }) };
        }
        return { status: 404, text: async () => "{}" };
      },
    });
    const log = new EventLog(false);
    const removed = await cleanupOrchFlags(opts(true), log, http);
    expect(removed).toEqual(["lift_orch_tmp"]);
    expect(deleted).toEqual(["lift_orch_tmp"]);
  });
});
