import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SITES } from "../../shared/catalog.ts";
import {
  aggregateSites,
  siteRowFromDocument,
  type SiteRow,
} from "../../shared/aggregate.ts";
import { historicLists } from "../../shared/experiment-history.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
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
      };
      headline: { source: string; copy: string };
      abandonedExperiments: { id: number }[];
      supersededExperiments: { id: number }[];
    }>(resolve(ROOT, "dashboard/results.json"));

    expect(results.headline.source).toBe("lift_median_of_flagsmith_lifts");
    expect(results.rows).toHaveLength(SITES.length);

    const fromSites: SiteRow[] = [];
    for (const site of SITES) {
      const doc = readJson<{
        site: string;
        flag: string;
        experimentId: number;
        producedBy?: string;
        commitSha?: string;
        flagsmithResults: { results?: { payload?: { metrics?: Array<{ variants?: Record<string, { n?: number; sum?: number }> }> } } };
        decision: SiteRow["decision"] extends never ? never : {
          flag: string;
          decision: SiteRow["decision"];
          source: SiteRow["source"];
          winProbabilityTreatment: number;
          lift: number | string | null;
          ciLow: number | null;
          ciHigh: number | null;
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
      if (site.id === "pricing") {
        expect(doc.frictionDisclosure).toMatch(/60% of treatment conversions are dropped by construction/);
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
    const fleetFixtures = readdirSync(fixtureDir).filter((name) =>
      name.startsWith("flagsmith-results-fleet-"),
    );
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
    }

    const historic = historicLists(
      results.rows.map((r) => r.experimentId).filter((id): id is number => typeof id === "number"),
    );
    const abandonedIds = new Set(results.abandonedExperiments?.map((e) => e.id) ?? []);
    const supersededIds = new Set(results.supersededExperiments?.map((e) => e.id) ?? []);
    for (const row of historic.abandonedExperiments) {
      expect(abandonedIds.has(row.id), `abandoned ${row.id}`).toBe(true);
    }
    for (const row of historic.supersededExperiments) {
      expect(supersededIds.has(row.id), `superseded ${row.id}`).toBe(true);
    }
  });
});
