import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SITES, getSite, barrierFlagMap, PRICING_FRICTION_DISCLOSURE } from "../../shared/catalog.ts";
import { PERSONAS } from "../../shared/types.ts";
import { aggregateSites, decisionLabel, type SiteRow } from "../../shared/aggregate.ts";
import { estimateFleetCalls } from "../../shared/estimate.ts";
import { scanSite } from "../../agent/src/scan.ts";
import { applyBaselineDropout, applyFrictionKeep } from "../../traffic/src/runner.ts";
import { mixSeed, mulberry32 } from "../../shared/rng.ts";

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
    expect(getSite("pricing").harmfulFix?.frictionKeepRate).toBe(0.4);
    expect(getSite("pricing").harmfulFix?.designedToLose).toBe(true);
    expect(getSite("pricing").harmfulFix?.note).toBe(PRICING_FRICTION_DISCLOSURE);
    for (const site of SITES) {
      expect(site.accessible.submit.length).toBeGreaterThan(0);
      expect(site.accessible.submitIds.length).toBeGreaterThan(0);
    }
  });

  it("keeps expected accessible names in the catalog, not generic-persona regexes", () => {
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../traffic/src/generic-personas.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/start trial\|book a visit/);
    expect(src).not.toMatch(/give to river keep\|view cart/i);
    expect(src).not.toMatch(/plans\|appointments\|shop\|bag/i);
    expect(src).not.toMatch(/terms\|harbor notes/i);
    expect(getSite("pricing").accessible.frictionConfirm).toBe("Start trial anyway");
    expect(getSite("search").accessible.searchButton).toBe("Search the catalog");
    expect(getSite("donate").accessible.open[0]?.name).toBe("Give to River Keep");
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
        producedBy: "fleet" as const,
        commitSha: "test",
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
        producedBy: "fleet" as const,
        commitSha: "test",
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
        producedBy: "fleet" as const,
        commitSha: "test",
      },
    ] satisfies SiteRow[];
    const agg = aggregateSites(rows);
    expect(agg.method).toBe("median_of_site_lifts");
    expect(agg.medianLift).toBeCloseTo(0.1);
    expect(agg.pooledLift).toBeCloseTo((0.5166666667 - 0.5) / 0.5);
    expect(agg.headline).toMatch(/conversion lift across 3 sites/);
    expect(agg.headline).toMatch(/SIMULATED/);
    expect(agg.headline).toMatch(/IQR/);
    expect(agg.pooledCopy).toMatch(/Pooled sensitivity/);
    expect(agg.pooledCopy).toMatch(/control 150\/300 vs treatment 155\/300/);
    expect(agg.multipleTestingNote).toMatch(/3 separate tests were run at 95%/);
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
    expect(estimate.notes[0]).toMatch(/Playwright runtime/);
    expect(estimate.notes[0]).toMatch(/400 identities per site/);
  });
});

describe("friction keep rate", () => {
  it("treats frictionKeepRate as P(keep), not P(drop)", () => {
    expect(applyFrictionKeep(true, () => 0.399, true, 0.4)).toEqual({
      converted: true,
      dropped: false,
    });
    expect(applyFrictionKeep(true, () => 0.4, true, 0.4)).toEqual({
      converted: false,
      dropped: true,
    });
    expect(applyFrictionKeep(true, () => 0.9, false, 0.4)).toEqual({
      converted: true,
      dropped: false,
    });
    expect(applyFrictionKeep(true, () => 0.1, true, 0.4)).toEqual({
      converted: true,
      dropped: false,
    });
  });

  it("baseline 0.75 × frictionKeep 0.4 yields about 0.30 over 10k independent draws", () => {
    const dropoutRand = mulberry32(mixSeed(20261126, "sim-friction", 0, "dropout"));
    const frictionRand = mulberry32(mixSeed(20261126, "sim-friction", 0, "friction"));
    const n = 10_000;
    const xs: number[] = [];
    const ys: number[] = [];
    let kept = 0;
    for (let i = 0; i < n; i += 1) {
      const x = dropoutRand();
      const y = frictionRand();
      xs.push(x);
      ys.push(y);
      const baseline = applyBaselineDropout(true, () => x, 0.75);
      const friction = applyFrictionKeep(baseline.converted, () => y, true, 0.4);
      if (friction.converted) kept += 1;
    }
    const observed = kept / n;
    expect(observed).toBeGreaterThan(0.28);
    expect(observed).toBeLessThan(0.32);
    const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
    const mx = mean(xs);
    const my = mean(ys);
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < n; i += 1) {
      const a = xs[i] - mx;
      const b = ys[i] - my;
      num += a * b;
      dx += a * a;
      dy += b * b;
    }
    const r = num / Math.sqrt(dx * dy);
    expect(Math.abs(r)).toBeLessThan(0.05);
  });
});
