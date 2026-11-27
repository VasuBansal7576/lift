import { describe, expect, it } from "vitest";
import { appliedVariantMatches, cookieMatchesIdentity } from "../../orchestrator/src/traffic-guard.ts";
import { resolveOrchSpecPath } from "../../shared/orch-site.ts";
import { REPO_ROOT } from "../../orchestrator/src/paths.ts";

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

  it("only serves orch-specs with valid spec ids", () => {
    expect(resolveOrchSpecPath("/orch-specs/full-v1.json", REPO_ROOT)?.endsWith("full-v1.json")).toBe(true);
    expect(resolveOrchSpecPath("/orch-specs/../secret.json", REPO_ROOT)).toBeNull();
    expect(resolveOrchSpecPath("/orch-specs/BAD.json", REPO_ROOT)).toBeNull();
    expect(resolveOrchSpecPath("/runtime/runtime.js", REPO_ROOT)).toBeNull();
  });
});
