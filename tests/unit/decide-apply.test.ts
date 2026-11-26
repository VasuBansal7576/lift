import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyDecision,
  decideExperiment,
  shouldApplyDecision,
  waitForFlagsmithResults,
} from "../../agent/src/decide.ts";
import { ROOT } from "../../agent/src/config.ts";
import { completeBody } from "../../agent/src/payloads.ts";
import type { VisitRecord } from "../../shared/types.ts";
import fixture from "../fixtures/flagsmith-results.json" with { type: "json" };

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

describe("shouldApplyDecision", () => {
  it("applies Flagsmith decisions and refuses local unless allowed", () => {
    const flagsmith = decideExperiment({
      flag: "checkout_a11y",
      visits: visits(),
      threshold: 0.95,
      flagsmith: fixture,
    });
    expect(flagsmith.source).toBe("flagsmith");
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

describe("applyDecision", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("POSTs the complete body only when running and verifies rollout_decision", async () => {
    mkdirSync(resolve(ROOT, "data"), { recursive: true });
    writeFileSync(
      resolve(ROOT, "data/state.json"),
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
      flagsmith: fixture,
    });
    await applyDecision(decision, {
      evaluateIdentity: async () => ({ variant: "treatment", value: "treatment" }),
    });
    expect(calls.some((c) => c.url.includes("/complete/"))).toBe(true);
  });

  it("refuses to complete when the experiment is not running", async () => {
    mkdirSync(resolve(ROOT, "data"), { recursive: true });
    writeFileSync(
      resolve(ROOT, "data/state.json"),
      JSON.stringify({ experimentId: 7, treatmentOptionId: 99, flagName: "checkout_a11y", flagId: 10 }),
    );
    vi.stubEnv("FLAGSMITH_ADMIN_API_TOKEN", "token");
    vi.stubEnv("FLAGSMITH_ENVIRONMENT_KEY", "env-key");
    vi.stubEnv("FLAGSMITH_API_URL", "https://api.flagsmith.com/api/v1/");
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
      flagsmith: fixture,
    });
    await expect(applyDecision(decision)).rejects.toThrow(/expected running/);
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
      0.9995436631926699,
    );
  });
});
