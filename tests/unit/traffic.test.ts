import { describe, expect, it } from "vitest";
import { mixSeed } from "../../shared/rng.ts";
import {
  applyBaselineDropout,
  assignVariant,
  runTraffic,
  variantFromFlag,
} from "../../traffic/src/runner.ts";

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
    expect(() =>
      variantFromFlag({
        variant: "mystery",
        experiment: { inExperiment: true },
      }),
    ).toThrow(/Unknown variant key/);
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

  it("throws without an admin token in the live path", async () => {
    await expect(
      runTraffic({
        serverKey: "ser-test",
        environmentKey: "env-test",
        adminToken: "",
      }),
    ).rejects.toThrow(/FLAGSMITH_ADMIN_API_TOKEN/);
  });
});

describe("mixSeed", () => {
  it("derives independent streams from run id and batch", () => {
    const a = mixSeed(20261126, "run-a", 0, "persona");
    const b = mixSeed(20261126, "run-b", 0, "persona");
    const c = mixSeed(20261126, "run-a", 1, "persona");
    const d = mixSeed(20261126, "run-a", 0, "dropout");
    const e = mixSeed(20261126, "run-a", 0, "friction");
    expect(new Set([a, b, c, d, e]).size).toBe(5);
  });
});

describe("applyBaselineDropout", () => {
  it("leaves blocked visits blocked and drops some conversions", () => {
    expect(applyBaselineDropout(false, () => 0, 0.75)).toEqual({
      converted: false,
      dropped: false,
    });
    expect(applyBaselineDropout(true, () => 0.1, 0.75)).toEqual({
      converted: true,
      dropped: false,
    });
    expect(applyBaselineDropout(true, () => 0.9, 0.75)).toEqual({
      converted: false,
      dropped: true,
    });
  });
});
