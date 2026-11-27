import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Browser, Page } from "@playwright/test";
import {
  BLOCKED_SURFACE,
  OPEN_SURFACE,
  SHARED_KEEP_RATE,
  appliedVariantMatches,
  cookieMatchesIdentity,
  focusIndicatorVisible,
  personaConvertsOnSurface,
  simulateArmRate,
} from "../../orchestrator/src/traffic-guard.ts";
import { resolveOrchSpecPath } from "../../shared/orch-site.ts";
import { EventLog } from "../../orchestrator/src/log.ts";
import { REPO_ROOT, specsDir } from "../../orchestrator/src/paths.ts";
import { writePassedSpecs } from "../../orchestrator/src/specs.ts";
import { runTrafficAgent, type TrafficFlagsmith } from "../../orchestrator/src/agents/traffic.ts";
import { testOrchOptions } from "./orch-opts.ts";
import type { FlagSetup } from "../../orchestrator/src/types.ts";

const flag: FlagSetup = {
  dryRun: false,
  flagName: "lift_orch_test",
  flagId: 1,
  metricId: 1,
  metricEvent: "checkout_completed",
  experimentId: 1,
  experimentName: "test",
  variants: [
    { key: "alpha", specId: "alpha", optionId: 1, title: "alpha" },
    { key: "beta", specId: "beta", optionId: 2, title: "beta" },
  ],
  controlKey: "control",
  dashboardUrl: "http://127.0.0.1:8000",
  usedCli: false,
};

describe("traffic identity + marker", () => {
  it("asserts lift_vid cookie persistence", () => {
    expect(cookieMatchesIdentity([{ name: "lift_vid", value: "lift-sim-1" }], "lift-sim-1")).toBe(true);
    expect(cookieMatchesIdentity([{ name: "lift_vid", value: "other" }], "lift-sim-1")).toBe(false);
    expect(cookieMatchesIdentity([], "lift-sim-1")).toBe(false);
  });

  it("requires the runtime marker to match the Flagsmith variant", () => {
    expect(appliedVariantMatches("full-v1", "full-v1")).toBe(true);
    expect(appliedVariantMatches("control", "full-v1")).toBe(false);
    expect(appliedVariantMatches("", "control")).toBe(false);
    expect(appliedVariantMatches(undefined, "control")).toBe(false);
  });

  it("treats two named arms equally when the served surface is the same", () => {
    expect(SHARED_KEEP_RATE).toBe(0.9);
    const a = simulateArmRate({ surface: OPEN_SURFACE, n: 4000, seed: 42, arm: "full-v1" });
    const b = simulateArmRate({ surface: OPEN_SURFACE, n: 4000, seed: 42, arm: "g2-focus" });
    expect(Math.abs(a.rate - b.rate)).toBeLessThan(0.04);
    expect(a.rate).toBeGreaterThan(0.7);
    expect(personaConvertsOnSurface("keyboard", OPEN_SURFACE)).toBe(true);
    expect(personaConvertsOnSurface("keyboard", { ...OPEN_SURFACE, focusVisible: false })).toBe(false);
  });

  it("applies the focus-visible check identically on every arm", () => {
    const visible = {
      outlineStyle: "auto",
      outlineWidth: "2px",
      outlineColor: "rgb(0, 0, 0)",
      boxShadow: "none",
    };
    const hidden = {
      outlineStyle: "none",
      outlineWidth: "0px",
      outlineColor: "rgba(0, 0, 0, 0)",
      boxShadow: "none",
    };
    expect(focusIndicatorVisible(visible, hidden)).toBe(true);
    expect(focusIndicatorVisible(hidden, hidden)).toBe(false);
    const withRing = { ...OPEN_SURFACE, focusVisible: true };
    expect(simulateArmRate({ surface: withRing, n: 2000, seed: 3, arm: "alpha" }).rate).toBeCloseTo(
      simulateArmRate({ surface: withRing, n: 2000, seed: 3, arm: "beta" }).rate,
      1,
    );
  });

  it("flips the winner when the accessibility barrier moves to the other arm", () => {
    const aBlocked = simulateArmRate({ surface: BLOCKED_SURFACE, n: 3000, seed: 7, arm: "arm-a" });
    const bOpen = simulateArmRate({ surface: OPEN_SURFACE, n: 3000, seed: 7, arm: "arm-b" });
    expect(bOpen.rate).toBeGreaterThan(aBlocked.rate + 0.12);

    const aOpen = simulateArmRate({ surface: OPEN_SURFACE, n: 3000, seed: 7, arm: "arm-a" });
    const bBlocked = simulateArmRate({ surface: BLOCKED_SURFACE, n: 3000, seed: 7, arm: "arm-b" });
    expect(aOpen.rate).toBeGreaterThan(bBlocked.rate + 0.12);
  });

  it("only serves orch-specs with valid spec ids", () => {
    expect(resolveOrchSpecPath("/orch-specs/full-v1.json", REPO_ROOT)?.endsWith("full-v1.json")).toBe(true);
    expect(resolveOrchSpecPath("/orch-specs/../secret.json", REPO_ROOT)).toBeNull();
    expect(resolveOrchSpecPath("/orch-specs/BAD.json", REPO_ROOT)).toBeNull();
    expect(resolveOrchSpecPath("/runtime/runtime.js", REPO_ROOT)).toBeNull();
  });
});

describe("writePassedSpecs uses a tmp specs dir", () => {
  const previousState = process.env.LIFT_ORCH_STATE_DIR;
  const previousSpecs = process.env.LIFT_ORCH_SPECS_DIR;

  afterEach(() => {
    if (previousState === undefined) delete process.env.LIFT_ORCH_STATE_DIR;
    else process.env.LIFT_ORCH_STATE_DIR = previousState;
    if (previousSpecs === undefined) delete process.env.LIFT_ORCH_SPECS_DIR;
    else process.env.LIFT_ORCH_SPECS_DIR = previousSpecs;
  });

  it("removes leftover control.json so gen-1 control is the unpatched page", () => {
    const dir = mkdtempSync(join(tmpdir(), "lift-specs-"));
    process.env.LIFT_ORCH_STATE_DIR = dir;
    delete process.env.LIFT_ORCH_SPECS_DIR;
    mkdirSync(specsDir(), { recursive: true });
    const controlPath = resolve(specsDir(), "control.json");
    writeFileSync(controlPath, `${JSON.stringify({ id: "full-v1", version: 0, ops: [] })}\n`);
    writePassedSpecs([], null);
    expect(existsSync(controlPath)).toBe(false);
    expect(controlPath.startsWith(dir)).toBe(true);
  });
});

describe("runTrafficAgent", () => {
  const previousSeed = process.env.LIFT_TRAFFIC_SEED;
  const previousRun = process.env.LIFT_RUN_ID;
  const previousConcurrency = process.env.LIFT_ORCH_TRAFFIC_CONCURRENCY;

  afterEach(() => {
    if (previousSeed === undefined) delete process.env.LIFT_TRAFFIC_SEED;
    else process.env.LIFT_TRAFFIC_SEED = previousSeed;
    if (previousRun === undefined) delete process.env.LIFT_RUN_ID;
    else process.env.LIFT_RUN_ID = previousRun;
    if (previousConcurrency === undefined) delete process.env.LIFT_ORCH_TRAFFIC_CONCURRENCY;
    else process.env.LIFT_ORCH_TRAFFIC_CONCURRENCY = previousConcurrency;
  });

  it("gives equal conversion rates to the same surface under different variant names", async () => {
    process.env.LIFT_TRAFFIC_SEED = "42";
    process.env.LIFT_RUN_ID = "equalrate";
    process.env.LIFT_ORCH_TRAFFIC_CONCURRENCY = "8";
    const conversions: string[] = [];
    const flagsmith: TrafficFlagsmith = {
      getExperimentFlag: async (_name, identity) => {
        const index = Number(String(identity).split("-").pop());
        return {
          variant: index % 2 === 0 ? "alpha" : "beta",
          experiment: { inExperiment: true },
        };
      },
      trackEvent: (_event, payload) => {
        conversions.push(String((payload as { identifier?: string }).identifier ?? ""));
      },
      flushEvents: async () => undefined,
      close: async () => undefined,
    };
    const fakeBrowser = {
      newContext: async () => {
        let cookie = "";
        return {
          addCookies: async (cookies: Array<{ value: string }>) => {
            cookie = cookies[0]?.value ?? "";
          },
          cookies: async () => [{ name: "lift_vid", value: cookie }],
          newPage: async () => ({}) as Page,
          close: async () => undefined,
        };
      },
      close: async () => undefined,
    } as unknown as Browser;

    const visits = await runTrafficAgent(
      testOrchOptions({ apply: true, trafficN: 80, noUi: true }),
      flag,
      [],
      null,
      new EventLog(false),
      {
        flagsmith,
        launchBrowser: async () => fakeBrowser,
        gotoSite: async () => undefined,
        waitForAppliedVariant: async (_page, expected) => expected,
        runPersona: async () => ({ converted: true, blockedBy: [], reason: "stub converted" }),
      },
    );

    expect(visits).toHaveLength(80);
    const alpha = visits.filter((item) => item.variant === "alpha");
    const beta = visits.filter((item) => item.variant === "beta");
    expect(alpha.length).toBe(40);
    expect(beta.length).toBe(40);
    const alphaRate = alpha.filter((item) => item.converted).length / alpha.length;
    const betaRate = beta.filter((item) => item.converted).length / beta.length;
    expect(Math.abs(alphaRate - betaRate)).toBeLessThan(0.15);
    expect(conversions.length).toBe(visits.filter((item) => item.converted).length);
  });
});
