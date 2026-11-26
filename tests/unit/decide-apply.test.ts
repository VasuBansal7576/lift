import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyDecision,
  decideExperiment,
  floorsMet,
  shouldApplyDecision,
  variantMatches,
  waitForFlagsmithResults,
} from "../../agent/src/decide.ts";
import { completeBody } from "../../agent/src/payloads.ts";
import type { VisitRecord } from "../../shared/types.ts";
import fixture from "../fixtures/flagsmith-results.json" with { type: "json" };
import winner from "../fixtures/flagsmith-results-win.json" with { type: "json" };

function visits(n = 50): VisitRecord[] {
  return [
    ...Array.from({ length: n }, (_, i) => ({
      identity: `c${i}`,
      persona: "mouse" as const,
      variant: "control" as const,
      converted: i < 12,
      blockedBy: [],
      reason: "fixture",
      simulated: true as const,
    })),
    ...Array.from({ length: n }, (_, i) => ({
      identity: `t${i}`,
      persona: "keyboard" as const,
      variant: "treatment" as const,
      converted: true,
      blockedBy: [],
      reason: "fixture",
      simulated: true as const,
    })),
  ];
}

function loserVisits(n = 50): VisitRecord[] {
  return [
    ...Array.from({ length: n }, (_, i) => ({
      identity: `c${i}`,
      persona: "mouse" as const,
      variant: "control" as const,
      converted: true,
      blockedBy: [],
      reason: "fixture",
      simulated: true as const,
    })),
    ...Array.from({ length: n }, (_, i) => ({
      identity: `t${i}`,
      persona: "keyboard" as const,
      variant: "treatment" as const,
      converted: i < 5,
      blockedBy: [],
      reason: "fixture",
      simulated: true as const,
    })),
  ];
}

describe("shouldApplyDecision", () => {
  it("applies Flagsmith decisions and refuses local unless allowed", () => {
    const flagsmith = decideExperiment({
      flag: "checkout_a11y",
      visits: visits(),
      threshold: 0.95,
      flagsmith: winner,
    });
    expect(flagsmith.source).toBe("flagsmith");
    expect(flagsmith.decision).toBe("rollout_treatment");
    expect(shouldApplyDecision(flagsmith, false)).toBe(true);

    const local = decideExperiment({
      flag: "checkout_a11y",
      visits: visits(),
      threshold: 0.95,
      flagsmith: null,
    });
    expect(local.source).toBe("local_bayesian");
    expect(shouldApplyDecision(local, false)).toBe(false);
    expect(shouldApplyDecision(local, true)).toBe(true);
    expect(local.notes.some((n) => n.includes("Not completing"))).toBe(true);
    const localAllowed = decideExperiment({
      flag: "checkout_a11y",
      visits: visits(),
      threshold: 0.95,
      flagsmith: null,
      allowLocalDecision: true,
    });
    expect(localAllowed.notes.some((n) => n.includes("LIFT_ALLOW_LOCAL_DECISION=true"))).toBe(
      true,
    );
  });
});

describe("variantMatches", () => {
  it("requires both variant and value", () => {
    expect(variantMatches({ variant: "control", value: "control" }, "control")).toBe(true);
    expect(variantMatches({ variant: "treatment", value: "control" }, "control")).toBe(false);
    expect(variantMatches({ variant: undefined, value: "control" }, "control")).toBe(false);
    expect(variantMatches({ variant: "treatment", value: "treatment" }, "treatment")).toBe(true);
  });
});

describe("applyDecision", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lift-state-"));
    vi.stubEnv("LIFT_STATE_PATH", join(dir, "state.json"));
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        experimentId: 7,
        treatmentOptionId: 99,
        flagName: "checkout_a11y",
        flagId: 10,
      }),
    );
    vi.stubEnv("FLAGSMITH_ADMIN_API_TOKEN", "token");
    vi.stubEnv("FLAGSMITH_ENVIRONMENT_KEY", "env-key");
    vi.stubEnv("FLAGSMITH_API_URL", "https://api.flagsmith.com/api/v1/");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("POSTs the complete body only when running and verifies rollout_decision", async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, url, body });
        if (url.endsWith("/experiments/7/") && method === "GET") {
          const completed = calls.some((c) => c.url.includes("/complete/"));
          return new Response(
            JSON.stringify({
              id: 7,
              status: completed ? "completed" : "running",
              rollout_decision: completed ? "variant" : null,
              rollout_variant: completed ? 99 : null,
            }),
            { status: 200 },
          );
        }
        if (url.includes("/complete/") && method === "POST") {
          expect(body).toEqual(completeBody("rollout_treatment", 99));
          return new Response("{}", { status: 200 });
        }
        return new Response("no", { status: 404 });
      }),
    );

    const decision = decideExperiment({
      flag: "checkout_a11y",
      visits: visits(),
      threshold: 0.95,
      flagsmith: winner,
    });
    const verification = await applyDecision(decision, {
      evaluateIdentity: async () => ({ variant: "treatment", value: "treatment" }),
    });
    expect(calls.some((c) => c.url.includes("/complete/"))).toBe(true);
    expect(verification).toEqual({
      applied: true,
      n: 20,
      matched: 20,
      expected: "treatment",
      usedFallback: false,
    });
  });

  it("refuses to complete when the experiment is not running", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ id: 7, status: "completed", rollout_decision: "variant" }),
          { status: 200 },
        );
      }),
    );
    const decision = decideExperiment({
      flag: "checkout_a11y",
      visits: visits(),
      threshold: 0.95,
      flagsmith: winner,
    });
    await expect(applyDecision(decision)).rejects.toThrow(/expected running/);
  });

  it("completes pull_to_control and falls back to setDefault when variant and value disagree", async () => {
    const calls: { method: string; url: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ method, url });
        if (url.endsWith("/experiments/7/") && method === "GET") {
          const completed = calls.some((c) => c.url.includes("/complete/"));
          return new Response(
            JSON.stringify({
              id: 7,
              status: completed ? "completed" : "running",
              rollout_decision: completed ? "control" : null,
              rollout_variant: null,
            }),
            { status: 200 },
          );
        }
        if (url.includes("/complete/") && method === "POST") {
          const body = JSON.parse(String(init?.body));
          expect(body).toEqual(completeBody("pull_to_control", 99));
          return new Response("{}", { status: 200 });
        }
        return new Response("no", { status: 404 });
      }),
    );
    const decision = decideExperiment({
      flag: "checkout_a11y",
      visits: loserVisits(),
      threshold: 0.95,
      flagsmith: null,
      allowLocalDecision: true,
    });
    expect(decision.decision).toBe("pull_to_control");
    let evals = 0;
    const setDefault = vi.fn(async () => undefined);
    await applyDecision(decision, {
      allowLocalDecision: true,
      evaluateIdentity: async () => {
        evals += 1;
        if (evals <= 20) return { variant: "treatment", value: "control" };
        return { variant: "control", value: "control" };
      },
      setDefault,
    });
    expect(setDefault).toHaveBeenCalledTimes(1);
    expect(evals).toBe(40);
  });

  it("throws when complete/ rollout_decision does not stick", async () => {
    let gets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.includes("/complete/") && method === "POST") {
          return new Response("{}", { status: 200 });
        }
        if (url.endsWith("/experiments/7/") && method === "GET") {
          gets += 1;
          if (gets === 1) {
            return new Response(
              JSON.stringify({ id: 7, status: "running", rollout_decision: null }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              id: 7,
              status: "completed",
              rollout_decision: "control",
              rollout_variant: null,
            }),
            { status: 200 },
          );
        }
        return new Response("no", { status: 404 });
      }),
    );
    const decision = decideExperiment({
      flag: "checkout_a11y",
      visits: visits(),
      threshold: 0.95,
      flagsmith: winner,
    });
    await expect(
      applyDecision(decision, {
        evaluateIdentity: async () => ({ variant: "treatment", value: "treatment" }),
      }),
    ).rejects.toThrow(/did not stick/);
  });

  it("does not complete when the source is local_bayesian unless allowLocalDecision", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ id: 7, status: "running", rollout_decision: null }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const decision = decideExperiment({
      flag: "checkout_a11y",
      visits: visits(),
      threshold: 0.95,
      flagsmith: null,
    });
    expect(decision.source).toBe("local_bayesian");
    await applyDecision(decision);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("waitForFlagsmithResults", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("logs refresh errors and returns when chance_to_win appears", async () => {
    vi.stubEnv("FLAGSMITH_ADMIN_API_TOKEN", "token");
    vi.stubEnv("FLAGSMITH_ENVIRONMENT_KEY", "env-key");
    vi.stubEnv("FLAGSMITH_API_URL", "https://api.flagsmith.com/api/v1/");
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/refresh/") && (init?.method ?? "GET") === "POST") {
          return new Response("throttled", { status: 429 });
        }
        n += 1;
        if (n === 1) {
          return new Response(JSON.stringify({ results: null }), { status: 200 });
        }
        return new Response(JSON.stringify(fixture), { status: 200 });
      }),
    );
    const result = await waitForFlagsmithResults({
      experimentId: 7,
      visits: visits(),
      waitMs: 50,
      sleep: async () => undefined,
      now: (() => {
        let t = 0;
        return () => {
          t += 20;
          return t;
        };
      })(),
    });
    expect(result?.results?.payload?.metrics?.[0]?.inference?.treatment?.chance_to_win).toBe(
      fixture.results.payload.metrics[0].inference.treatment.chance_to_win,
    );
  });
});

describe("floorsMet", () => {
  it("ignores local counts when a Flagsmith payload exists and is under the floor", () => {
    const local = visits(60);
    const under = {
      results: {
        payload: {
          metrics: [
            {
              variants: {
                control: { n: 10, sum: 8 },
                treatment: { n: 12, sum: 12 },
              },
              inference: { treatment: { chance_to_win: 0.99, lift: 0.4 } },
            },
          ],
        },
      },
    };
    expect(floorsMet(local, null)).toBe(true);
    expect(floorsMet(local, under)).toBe(false);
    const decision = decideExperiment({
      flag: "checkout_a11y",
      visits: local,
      threshold: 0.95,
      flagsmith: under,
    });
    expect(decision.decision).toBe("keep_running");
    expect(decision.notes.some((n) => n.includes("awaiting ingestion"))).toBe(true);
  });

  it("returns false when a Flagsmith arm is missing", () => {
    expect(
      floorsMet(visits(60), {
        results: {
          payload: {
            metrics: [
              {
                variants: { treatment: { n: 60, sum: 40 } },
                inference: { treatment: { chance_to_win: 0.99, lift: 0.4 } },
              },
            ],
          },
        },
      }),
    ).toBe(false);
  });

  it("returns false when the control arm is under the identity floor", () => {
    expect(
      floorsMet(visits(60), {
        results: {
          payload: {
            metrics: [
              {
                variants: {
                  control: { n: 10, sum: 8 },
                  treatment: { n: 60, sum: 40 },
                },
                inference: { treatment: { chance_to_win: 0.99, lift: 0.4 } },
              },
            ],
          },
        },
      }),
    ).toBe(false);
  });

  it("returns false when the payload has inference but no variants", () => {
    const local = visits(60);
    expect(
      floorsMet(local, {
        results: {
          payload: {
            metrics: [{ inference: { treatment: { chance_to_win: 0.99, lift: 0.4 } } }],
          },
        },
      }),
    ).toBe(false);
  });
});
