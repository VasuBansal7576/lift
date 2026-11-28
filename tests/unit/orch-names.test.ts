import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_MARKER,
  FLAG_PREFIX,
  SPEC_ID_RE,
  assertOrchFlagName,
  assertSpecId,
  genFlagName,
  isOrchDescription,
  isValidSpecId,
} from "../../orchestrator/src/names.ts";
import { parseApproveArg, parseArgv, parseResultsArg } from "../../orchestrator/src/config.ts";

describe("orch names", () => {
  it("requires lift_orch_ prefix and a description marker", () => {
    expect(FLAG_PREFIX).toBe("lift_orch_");
    expect(DESCRIPTION_MARKER).toMatch(/Lift orchestrator/);
    expect(() => assertOrchFlagName("checkout_orch_a11y")).toThrow(/lift_orch_/);
    expect(() => assertOrchFlagName("lift_orch_checkout")).not.toThrow();
    expect(genFlagName("lift_orch_checkout", 2)).toBe("lift_orch_checkout_g2");
    expect(isOrchDescription("nope")).toBe(false);
    expect(isOrchDescription(`${DESCRIPTION_MARKER}. extra`)).toBe(true);
  });

  it("requires spec ids to match ^[a-z0-9-]{1,40}$", () => {
    expect(isValidSpecId("full-v1")).toBe(true);
    expect(SPEC_ID_RE.test("BAD")).toBe(false);
    expect(() => assertSpecId("no spaces allowed")).toThrow(/Spec id/);
    expect(() => assertSpecId("x".repeat(41))).toThrow(/Spec id/);
  });
});

describe("parseArgv --approve", () => {
  it("requires an experiment id and has no boolean-only form", () => {
    expect(() => parseApproveArg(["--approve"])).toThrow(/experiment id/);
    expect(parseApproveArg(["--approve", "12"])).toEqual({ approve: true, approveExperimentId: 12 });
    expect(parseApproveArg(["--approve=9"])).toEqual({ approve: true, approveExperimentId: 9 });
    expect(parseApproveArg(["--apply"])).toEqual({ approve: false, approveExperimentId: null });
  });

  it("rejects a flag name without the lift_orch_ prefix", () => {
    expect(() => parseArgv(["--flag-name", "checkout_orch_a11y"])).toThrow(/lift_orch_/);
  });

  it("parses --results and --from-generation", () => {
    expect(parseResultsArg(["--results", "53"])).toBe(53);
    expect(parseResultsArg(["--results=9"])).toBe(9);
    expect(parseResultsArg(["--apply"])).toBeNull();
    const parsed = parseArgv(["--results", "12", "--from-generation", "2", "--generations", "2"]);
    expect(parsed.resultsExperimentId).toBe(12);
    expect(parsed.fromGeneration).toBe(2);
    expect(parsed.generations).toBe(2);
  });
});
