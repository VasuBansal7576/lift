import { describe, expect, it } from "vitest";
import { SITES, getSite, barrierFlagMap } from "../../shared/catalog.ts";
import { PERSONAS } from "../../shared/types.ts";
import { aggregateSites, decisionLabel } from "../../shared/aggregate.ts";
import { estimateFleetCalls } from "../../shared/estimate.ts";
import { scanSite } from "../../agent/src/scan.ts";
import { applyFrictionDropout } from "../../traffic/src/runner.ts";

describe("site catalog", () => {
  it("ships checkout plus 7 demo sites with unique flags and metrics", () => {
    expect(SITES.map((s) => s.id)).toEqual([
      "checkout",
      "signup",
      "pricing",
      "newsletter",
      "donate",
      "booking",
      "login",
      "search",
    ]);
    const flags = new Set(SITES.map((s) => s.flagName));
    const metrics = new Set(SITES.map((s) => s.metricEvent));
    expect(flags.size).toBe(SITES.length);
    expect(metrics.size).toBe(SITES.length);
    for (const site of SITES) {
      expect(site.barriers.length).toBeGreaterThanOrEqual(3);
      expect(site.barriers.length).toBeLessThanOrEqual(6);
      const map = barrierFlagMap(site);
      expect(Object.keys(map).length).toBe(site.barriers.length);
      for (const persona of PERSONAS) {
        expect(site.controlBlocked[persona]).toBeDefined();
      }
    }
    expect(getSite("pricing").harmfulFix?.barrierId).toBe("extra_confirm");
  });

  it("scans data-barrier markers on every fixture", () => {
    for (const site of SITES) {
      const scan = scanSite(site.id);
      expect(scan.missing, site.id).toEqual([]);
      expect(scan.findings.length, site.id).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("fleet aggregation", () => {
  it("uses the unweighted median of per-site lifts as the headline", () => {
    const rows = [
      {
        site: "a",
        name: "A",
        flag: "a_a11y",
        experimentId: 1,
        flagsmithDashboard: "https://app.flagsmith.com/a",
        control: { visitors: 100, conversions: 50, rate: 0.5 },
        treatment: { visitors: 100, conversions: 60, rate: 0.6 },
        lift: 0.2,
        ciLow: 0.1,
        ciHigh: 0.3,
        winProbabilityTreatment: 0.99,
        decision: "rollout_treatment" as const,
        source: "flagsmith" as const,
      },
      {
        site: "b",
        name: "B",
        flag: "b_a11y",
        experimentId: 2,
        flagsmithDashboard: "https://app.flagsmith.com/b",
        control: { visitors: 100, conversions: 50, rate: 0.5 },
        treatment: { visitors: 100, conversions: 40, rate: 0.4 },
        lift: -0.2,
        ciLow: -0.3,
        ciHigh: -0.1,
        winProbabilityTreatment: 0.02,
        decision: "pull_to_control" as const,
        source: "flagsmith" as const,
      },
      {
        site: "c",
        name: "C",
        flag: "c_a11y",
        experimentId: 3,
        flagsmithDashboard: "https://app.flagsmith.com/c",
        control: { visitors: 100, conversions: 50, rate: 0.5 },
        treatment: { visitors: 100, conversions: 55, rate: 0.55 },
        lift: 0.1,
        ciLow: 0,
        ciHigh: 0.2,
        winProbabilityTreatment: 0.8,
        decision: "keep_running" as const,
        source: "flagsmith" as const,
      },
    ];
    const agg = aggregateSites(rows);
    expect(agg.method).toBe("median_of_site_lifts");
    expect(agg.medianLift).toBeCloseTo(0.1);
    expect(agg.pooledLift).toBeCloseTo((0.5166666667 - 0.5) / 0.5);
    expect(agg.headline).toMatch(/conversion lift across 3 sites/);
    expect(agg.headline).toMatch(/SIMULATED/);
    expect(decisionLabel("pull_to_control")).toBe("pulled");
    expect(decisionLabel("rollout_treatment")).toBe("rolled out");
    expect(decisionLabel("keep_running")).toBe("still running");
  });
});

describe("fleet API estimate", () => {
  it("stays far under the 50k/month free budget at 200/arm", () => {
    const estimate = estimateFleetCalls();
    expect(estimate.armN).toBe(200);
    expect(estimate.sites).toBe(8);
    expect(estimate.visitors).toBe(3200);
    expect(estimate.total).toBeLessThan(2000);
  });
});

describe("friction dropout", () => {
  it("only applies when the treatment friction step is present", () => {
    expect(applyFrictionDropout(true, () => 0.9, false, 0.4)).toEqual({
      converted: true,
      dropped: false,
    });
    expect(applyFrictionDropout(true, () => 0.9, true, 0.4)).toEqual({
      converted: false,
      dropped: true,
    });
    expect(applyFrictionDropout(true, () => 0.1, true, 0.4)).toEqual({
      converted: true,
      dropped: false,
    });
  });
});
