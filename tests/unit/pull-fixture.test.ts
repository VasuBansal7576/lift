import { describe, expect, it } from "vitest";
import fixture from "../fixtures/pull-to-control-eval.json" with { type: "json" };

describe("pull-to-control eval fixture", () => {
  it("records variant and value after complete to control", () => {
    expect(fixture.rolloutDecision).toBe("control");
    expect(fixture.experimentStatus).toBe("completed");
    expect(fixture.evaluation.variant).toBe("control");
    expect(fixture.evaluation.value).toBe("control");
    expect(fixture.flag).toBe("lift_pull_probe");
  });
});
