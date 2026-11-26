import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SITES, expectedLiftByConstruction } from "../../shared/catalog.ts";
import {
  aggregateSites,
  siteRowFromDocument,
  type SiteRow,
} from "../../shared/aggregate.ts";
import { ABANDONED_REASON, historicLists } from "../../shared/experiment-history.ts";
import { relativeLift } from "../../agent/src/stats.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function fleetFixtureNames(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith("flagsmith-results-fleet-"));
}

describe("committed fleet fixtures", () => {
  it("matches results.json, sites/*.json, and recomputes median and pooled lifts", () => {
    const results = readJson<{
      rows: SiteRow[];
      aggregate: {
        medianLift: number | null;
        pooledLift: number | null;
        pooledControl: { visitors: number; conversions: number };
        pooledTreatment: { visitors: number; conversions: number };
        secondary?: { medianLift: number | null; pooledLift: number | null; siteCount: number };
        siteCount: number;
      };
      headline: { source: string; copy: string };
      abandonedExperiments: { id: number }[];
      supersededExperiments: { id: number }[];
    }>(resolve(ROOT, "dashboard/results.json"));

    expect(results.headline.source).toBe("lift_median_of_flagsmith_lifts");
    expect(results.rows).toHaveLength(SITES.length);
    expect(results.headline.copy).toMatch(/conversion lift across 7 sites/);
    expect(results.aggregate.siteCount).toBe(7);
    expect(results.aggregate.secondary?.siteCount).toBe(8);

    const fromSites: SiteRow[] = [];
    for (const site of SITES) {
      const doc = readJson<{
        site: string;
        flag: string;
        experimentId: number;
        producedBy?: string;
        commitSha?: string;
        expectedLift?: number | null;
        blockedShare?: number | null;
        designedToLose?: boolean;
        flagsmithResults: { results?: { payload?: { metrics?: Array<{ variants?: Record<string, { n?: number; sum?: number }> }> } } };
        decision: {
          flag: string;
          decision: SiteRow["decision"];
          source: SiteRow["source"];
          winProbabilityTreatment: number;
          lift: number | string | null;
          ciLow: number | null;
          ciHigh: number | null;
          srmPValue?: number | null;
          srmSource?: SiteRow["srmSource"];
          control: SiteRow["control"];
          treatment: SiteRow["treatment"];
        };
        frictionDisclosure?: string | null;
      }>(resolve(ROOT, `dashboard/sites/${site.id}.json`));
      expect(doc.site).toBe(site.id);
      const row = results.rows.find((r) => r.site === site.id);
      expect(row, site.id).toBeDefined();
      expect(row?.experimentId).toBe(doc.experimentId);
      expect(row?.control).toEqual(doc.decision.control);
      expect(row?.treatment).toEqual(doc.decision.treatment);
      expect(row?.winProbabilityTreatment).toBe(doc.decision.winProbabilityTreatment);
      expect(row?.decision).toBe(doc.decision.decision);
      expect(row?.producedBy).toBeTruthy();
      expect(row?.commitSha).toBeTruthy();
      expect(doc.decision.srmPValue, site.id).toEqual(expect.any(Number));
      expect(doc.decision.srmSource).toMatch(/^(flagsmith|lift)$/);
      expect(doc.expectedLift).toBeCloseTo(expectedLiftByConstruction(site), 10);
      if (site.id === "pricing") {
        expect(doc.frictionDisclosure).toMatch(/60% of treatment conversions are dropped by construction/);
        expect(row?.designedToLose).toBe(true);
      }
      fromSites.push(
        siteRowFromDocument({
          site: doc.site,
          flag: doc.flag,
          experimentId: doc.experimentId,
          producedBy: (doc.producedBy as SiteRow["producedBy"]) ?? "fleet",
          commitSha: doc.commitSha ?? "test",
          decision: doc.decision,
        }),
      );
    }

    const agg = aggregateSites(fromSites);
    expect(agg.medianLift).toBeCloseTo(results.aggregate.medianLift ?? NaN, 10);
    expect(agg.pooledLift).toBeCloseTo(results.aggregate.pooledLift ?? NaN, 10);
    expect(agg.pooledControl.visitors).toBe(results.aggregate.pooledControl.visitors);
    expect(agg.pooledTreatment.visitors).toBe(results.aggregate.pooledTreatment.visitors);

    const fixtureDir = resolve(ROOT, "tests/fixtures");
    const supersededDir = resolve(ROOT, "tests/fixtures/superseded");
    const currentIds = new Set(
      results.rows.map((r) => r.experimentId).filter((id): id is number => typeof id === "number"),
    );
    const supersededIds = new Set(results.supersededExperiments?.map((e) => e.id) ?? []);
    const fleetFixtures = fleetFixtureNames(fixtureDir);
    expect(fleetFixtures.length).toBe(SITES.length);

    for (const name of fleetFixtures) {
      const match = name.match(/^flagsmith-results-fleet-([a-z]+)-(\d+)\.json$/);
      expect(match, name).toBeTruthy();
      const siteId = match?.[1] ?? "";
      const experimentId = Number(match?.[2]);
      const row = results.rows.find((r) => r.site === siteId);
      expect(row?.experimentId, name).toBe(experimentId);
      const fixture = readJson<{
        results?: { payload?: { metrics?: Array<{ variants?: Record<string, { n?: number; sum?: number }> }> } };
      }>(resolve(fixtureDir, name));
      const siteDoc = readJson<{ flagsmithResults: typeof fixture }>(
        resolve(ROOT, `dashboard/sites/${siteId}.json`),
      );
      const fixtureVariants = fixture.results?.payload?.metrics?.[0]?.variants;
      const siteVariants = siteDoc.flagsmithResults.results?.payload?.metrics?.[0]?.variants;
      expect(fixtureVariants, name).toEqual(siteVariants);
      expect(fixtureVariants?.control?.n).toBe(row?.control.visitors);
      expect(fixtureVariants?.treatment?.n).toBe(row?.treatment.visitors);
      expect(fixtureVariants?.control?.sum).toBe(row?.control.conversions);
      expect(fixtureVariants?.treatment?.sum).toBe(row?.treatment.conversions);
      const controlRate = (fixtureVariants?.control?.sum ?? 0) / (fixtureVariants?.control?.n ?? 1);
      const treatmentRate = (fixtureVariants?.treatment?.sum ?? 0) / (fixtureVariants?.treatment?.n ?? 1);
      const fromCounts = relativeLift(treatmentRate, controlRate);
      expect(fromCounts, name).not.toBeNull();
      expect(Math.abs((fromCounts ?? NaN) - (row?.lift ?? NaN))).toBeLessThan(1e-9);
    }

    for (const name of fleetFixtureNames(supersededDir)) {
      const match = name.match(/^flagsmith-results-fleet-([a-z]+)-(\d+)\.json$/);
      expect(match, name).toBeTruthy();
      const experimentId = Number(match?.[2]);
      expect(currentIds.has(experimentId), name).toBe(false);
      expect(supersededIds.has(experimentId), `superseded fixture ${name}`).toBe(true);
    }

    const historic = historicLists(
      results.rows.map((r) => r.experimentId).filter((id): id is number => typeof id === "number"),
    );
    const abandonedIds = new Set(results.abandonedExperiments?.map((e) => e.id) ?? []);
    for (const row of historic.abandonedExperiments) {
      expect(abandonedIds.has(row.id), `abandoned ${row.id}`).toBe(true);
      expect(row.reason).toBe(ABANDONED_REASON);
    }
    for (const row of historic.supersededExperiments) {
      expect(supersededIds.has(row.id), `superseded ${row.id}`).toBe(true);
    }
  });
});
