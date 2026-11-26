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
import {
  ABANDONED_EXPERIMENTS,
  ABANDONED_REASON,
  F1_RERUN_ABANDONED,
  historicLists,
} from "../../shared/experiment-history.ts";
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
      producedBy?: string;
      dataCommitSha?: string;
      aggregationCommitSha?: string;
      rows: SiteRow[];
      aggregate: {
        medianLift: number | null;
        iqrLow: number | null;
        iqrHigh: number | null;
        liftMin: number | null;
        liftMax: number | null;
        pooledLift: number | null;
        pooledControl: { visitors: number; conversions: number };
        pooledTreatment: { visitors: number; conversions: number };
        secondary?: {
          medianLift: number | null;
          iqrLow: number | null;
          iqrHigh: number | null;
          liftMin: number | null;
          liftMax: number | null;
          pooledLift: number | null;
          pooledControl: { visitors: number; conversions: number };
          pooledTreatment: { visitors: number; conversions: number };
          siteCount: number;
        };
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
    expect(agg.iqrLow).toBeCloseTo(results.aggregate.iqrLow ?? NaN, 10);
    expect(agg.iqrHigh).toBeCloseTo(results.aggregate.iqrHigh ?? NaN, 10);
    expect(agg.liftMin).toBeCloseTo(results.aggregate.liftMin ?? NaN, 10);
    expect(agg.liftMax).toBeCloseTo(results.aggregate.liftMax ?? NaN, 10);
    expect(agg.pooledLift).toBeCloseTo(results.aggregate.pooledLift ?? NaN, 10);
    expect(agg.pooledControl.visitors).toBe(results.aggregate.pooledControl.visitors);
    expect(agg.pooledTreatment.visitors).toBe(results.aggregate.pooledTreatment.visitors);
    expect(agg.secondary.siteCount).toBe(8);
    expect(agg.secondary.medianLift).toBeCloseTo(results.aggregate.secondary?.medianLift ?? NaN, 10);
    expect(agg.secondary.iqrLow).toBeCloseTo(results.aggregate.secondary?.iqrLow ?? NaN, 10);
    expect(agg.secondary.iqrHigh).toBeCloseTo(results.aggregate.secondary?.iqrHigh ?? NaN, 10);
    expect(agg.secondary.liftMin).toBeCloseTo(results.aggregate.secondary?.liftMin ?? NaN, 10);
    expect(agg.secondary.liftMax).toBeCloseTo(results.aggregate.secondary?.liftMax ?? NaN, 10);
    expect(agg.secondary.pooledLift).toBeCloseTo(results.aggregate.secondary?.pooledLift ?? NaN, 10);
    expect(results.aggregate.pooledControl.conversions).toBe(766);
    expect(results.aggregate.pooledTreatment.conversions).toBe(1092);
    expect(results.aggregate.secondary?.pooledControl.conversions).toBe(895);
    expect(results.aggregate.secondary?.pooledTreatment.conversions).toBe(1155);
    expect(agg.pooledControl.conversions).toBe(766);
    expect(agg.pooledTreatment.conversions).toBe(1092);
    expect(agg.secondary.pooledControl.conversions).toBe(895);
    expect(agg.secondary.pooledTreatment.conversions).toBe(1155);
    expect(results.producedBy).toMatch(/^(fleet|rebuild|experiment)$/);
    expect(results.dataCommitSha).toBeTruthy();
    expect(results.aggregationCommitSha).toBeTruthy();
    expect(results.aggregationCommitSha).not.toMatch(/-dirty$/);
    const shaRe = /^[0-9a-f]{40}$/;
    for (const part of (results.dataCommitSha ?? "").split(",")) {
      expect(part.trim()).toMatch(shaRe);
    }
    expect(results.aggregationCommitSha).toMatch(shaRe);

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

  it("lists every committed fixture experiment id as current, superseded, or abandoned", () => {
    const results = readJson<{
      rows: { experimentId?: number | null }[];
      abandonedExperiments: { id: number }[];
      supersededExperiments: { id: number }[];
    }>(resolve(ROOT, "dashboard/results.json"));
    const listed = new Set<number>([
      ...results.rows.map((row) => row.experimentId).filter((id): id is number => typeof id === "number"),
      ...results.abandonedExperiments.map((row) => row.id),
      ...results.supersededExperiments.map((row) => row.id),
    ]);
    const dirs = [resolve(ROOT, "tests/fixtures"), resolve(ROOT, "tests/fixtures/superseded")];
    for (const dir of dirs) {
      for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
        const fleet = name.match(/^flagsmith-results-fleet-[a-z]+-(\d+)\.json$/);
        const site1 = name.match(/^flagsmith-results-(\d+)\.json$/);
        const id = Number(fleet?.[1] ?? site1?.[1] ?? NaN);
        if (!Number.isFinite(id)) continue;
        expect(listed.has(id), `${dir}/${name}`).toBe(true);
      }
    }
  });

  it("does not attribute 404 gap IDs to a site", () => {
    for (const row of [...ABANDONED_EXPERIMENTS, ...F1_RERUN_ABANDONED]) {
      expect(row.reason).toBe(ABANDONED_REASON);
      expect(row.site === null || row.site.startsWith("adjacent to ")).toBe(true);
    }
  });
});
