import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BLOCKED_SURFACE,
  OPEN_SURFACE,
  SHARED_KEEP_RATE,
  appliedVariantMatches,
  cookieMatchesIdentity,
  simulateArmRate,
} from "../../orchestrator/src/traffic-guard.ts";
import { resolveOrchSpecPath } from "../../shared/orch-site.ts";
import { REPO_ROOT, specsDir } from "../../orchestrator/src/paths.ts";
import { writePassedSpecs } from "../../orchestrator/src/specs.ts";

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

  it("uses the same keep rate for every arm name", () => {
    expect(SHARED_KEEP_RATE).toBeGreaterThan(0.5);
    expect(SHARED_KEEP_RATE).toBeLessThan(1);
  });

  it("gives two identical surfaces statistically equal conversion rates", () => {
    const a = simulateArmRate({ surface: OPEN_SURFACE, n: 4000, seed: 42, arm: "full-v1" });
    const b = simulateArmRate({ surface: OPEN_SURFACE, n: 4000, seed: 42, arm: "control" });
    expect(Math.abs(a.rate - b.rate)).toBeLessThan(0.04);
    expect(a.rate).toBeGreaterThan(0.7);
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

  it("removes leftover control.json so gen-1 control is the unpatched page", () => {
    const controlPath = resolve(specsDir(), "control.json");
    writeFileSync(controlPath, `${JSON.stringify({ id: "full-v1", version: 0, ops: [] })}\n`);
    writePassedSpecs([], null);
    expect(existsSync(controlPath)).toBe(false);
  });
});
