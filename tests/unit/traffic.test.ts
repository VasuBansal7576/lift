import { describe, expect, it } from "vitest";
import { assignVariant, runTraffic, variantFromFlag } from "../../traffic/src/runner.ts";
import { expectedBlocked } from "../../traffic/src/personas.ts";
import type { Persona } from "../../shared/types.ts";

describe("variantFromFlag / assignVariant", () => {
  it("throws unless the identity is in a running experiment with a variant", () => {
    expect(() =>
      variantFromFlag({ value: "treatment", variant: "treatment" }),
    ).toThrow(/not enrolled/);
    expect(() =>
      variantFromFlag({
        variant: undefined,
        experiment: { inExperiment: true },
      }),
    ).toThrow(/no variant/);
    expect(
      variantFromFlag({
        variant: "treatment",
        experiment: { inExperiment: true },
      }),
    ).toBe("treatment");
  });

  it("assignVariant returns the Flagsmith variant", async () => {
    const flagsmith = {
      getExperimentFlag: async () => ({
        enabled: true,
        variant: "control",
        value: "control",
        experiment: { inExperiment: true, id: 1, name: "exp" },
      }),
    };
    const { variant } = await assignVariant(
      flagsmith as never,
      "checkout_a11y",
      "id-1",
      "mouse",
    );
    expect(variant).toBe("control");
  });
});

describe("runTraffic", () => {
  it("throws without Flagsmith keys", async () => {
    await expect(
      runTraffic({ serverKey: "", environmentKey: "" }),
    ).rejects.toThrow(/FLAGSMITH_SERVER_KEY/);
  });
});

describe("expectedBlocked", () => {
  const personas: Persona[] = ["mouse", "keyboard", "screen-reader", "low-vision"];
  it("is exact per persona on control", () => {
    expect(expectedBlocked("mouse", "control")).toEqual([]);
    expect(expectedBlocked("keyboard", "control")).toEqual(["hover_menu"]);
    expect(expectedBlocked("screen-reader", "control")).toEqual([
      "hover_menu",
      "unlabeled_icon",
    ]);
    expect(expectedBlocked("low-vision", "control")).toEqual(["low_contrast"]);
  });
  it("is empty on treatment", () => {
    for (const persona of personas) {
      expect(expectedBlocked(persona, "treatment")).toEqual([]);
    }
  });
});
