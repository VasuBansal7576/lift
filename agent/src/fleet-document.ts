import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SITES } from "../../shared/catalog.ts";
import {
  aggregateSites,
  decisionLabel,
  siteRowFromDocument,
  LIFT_CONSTRUCTION_NOTE,
  type ProducedBy,
  type SiteRow,
} from "../../shared/aggregate.ts";
import { gitCommitSha } from "../../shared/git.ts";
import { historicLists } from "../../shared/experiment-history.ts";
import { chiSquareSrmFromDoc } from "./srm-from-doc.ts";
import {
  estimateFleetCalls,
  FLEET_ARM_N,
  type FleetCallEstimate,
} from "../../shared/estimate.ts";
import { DEFAULT_PERSONA_MIX } from "../../shared/types.ts";
import { srmPValue } from "./stats.ts";
import { fleetResultsPath, resultsPath } from "./config.ts";
import type { FlagsmithResultsEnvelope } from "./decide.ts";

export { estimateFleetCalls, FLEET_ARM_N };

export function dataCommitShaFromRows(rows: SiteRow[]): string {
  const shas = [
    ...new Set(rows.map((row) => row.commitSha).filter((sha) => Boolean(sha) && sha !== "unknown")),
  ];
  if (shas.length === 0) return gitCommitSha();
  if (shas.length === 1) return shas[0];
  return [...shas].sort().join(",");
}

export function buildFleetDocument(
  rows: SiteRow[],
  estimate: FleetCallEstimate,
  producedBy: ProducedBy = "fleet",
  aggregationCommitSha = gitCommitSha(),
) {
  const mix = DEFAULT_PERSONA_MIX;
  const aggregate = aggregateSites(rows, mix);
  const dataCommitSha = dataCommitShaFromRows(rows);
  const currentIds = rows
    .map((row) => row.experimentId)
    .filter((id): id is number => typeof id === "number");
  const historic = historicLists(currentIds);
  return {
    traffic: "simulated" as const,
    label:
      "SIMULATED TRAFFIC — Playwright persona bots, not humans. Demonstration of the pipeline; outcomes follow the persona model, not evidence about real users.",
    generatedAt: new Date().toISOString(),
    producedBy,
    dataCommitSha,
    aggregationCommitSha,
    commitSha: aggregationCommitSha,
    sites: rows.length,
    site: "fleet",
    personaMix: mix,
    estimate,
    aggregate,
    headline: {
      conversionLift: aggregate.medianLift,
      displayLift: aggregate.medianLift,
      source: "lift_median_of_flagsmith_lifts" as const,
      copy: aggregate.headline,
      method: aggregate.method,
      iqrLow: aggregate.iqrLow,
      iqrHigh: aggregate.iqrHigh,
      pooledLift: aggregate.pooledLift,
      pooledCopy: aggregate.pooledCopy,
      multipleTestingNote: aggregate.multipleTestingNote,
      constructionNote: aggregate.constructionNote,
      pipelineCheckNote: aggregate.pipelineCheckNote,
      secondary: aggregate.secondary,
    },
    outcome: aggregate.headline,
    honesty: LIFT_CONSTRUCTION_NOTE,
    constructionNote: LIFT_CONSTRUCTION_NOTE,
    rows: rows.map((row) => ({
      ...row,
      producedBy: row.producedBy,
      commitSha: row.commitSha || aggregationCommitSha,
      decisionLabel: decisionLabel(row.decision),
    })),
    flags: rows.map((row) => ({
      name: row.flag,
      role: "experiment" as const,
      site: row.site,
      control: row.control,
      treatment: row.treatment,
      winProbabilityTreatment: row.winProbabilityTreatment,
      ciLow: row.ciLow,
      ciHigh: row.ciHigh,
      source: row.source,
      decision: row.decision,
      flagsmithDashboard: row.flagsmithDashboard,
      producedBy: row.producedBy,
      commitSha: row.commitSha || aggregationCommitSha,
      expectedLift: row.expectedLift,
      blockedShare: row.blockedShare,
      designedToLose: row.designedToLose,
    })),
    abandonedExperiments: historic.abandonedExperiments,
    supersededExperiments: historic.supersededExperiments,
  };
}

interface SiteDashboardDoc {
  site?: string;
  flag?: string;
  experimentId?: number | null;
  flagsmithDashboard?: string | null;
  producedBy?: ProducedBy;
  commitSha?: string;
  expectedLift?: number | null;
  blockedShare?: number | null;
  designedToLose?: boolean;
  frictionDisclosure?: string | null;
  flagsmithResults?: FlagsmithResultsEnvelope | null;
  decision: Parameters<typeof siteRowFromDocument>[0]["decision"] & {
    srmPValue?: number | null;
    srmSource?: "flagsmith" | "lift" | null;
  };
}

function readSiteDoc(path: string): SiteDashboardDoc {
  return JSON.parse(readFileSync(path, "utf8")) as SiteDashboardDoc;
}

export function enrichSiteDocument(doc: SiteDashboardDoc): SiteDashboardDoc {
  const row = siteRowFromDocument(doc);
  const fromFlagsmith = doc.flagsmithResults?.results?.payload;
  const flagsmithSrm =
    typeof fromFlagsmith?.srm_p_value === "number" ? fromFlagsmith.srm_p_value : null;
  let srmPValueOut = flagsmithSrm;
  let srmSource: "flagsmith" | "lift" | null = flagsmithSrm !== null ? "flagsmith" : null;
  if (srmPValueOut === null) {
    const computed = chiSquareSrmFromDoc(doc, srmPValue);
    srmPValueOut = computed.value;
    srmSource = computed.source;
  }
  return {
    ...doc,
    expectedLift: row.expectedLift,
    blockedShare: row.blockedShare,
    designedToLose: row.designedToLose,
    frictionDisclosure: row.frictionDisclosure,
    decision: {
      ...doc.decision,
      srmPValue: srmPValueOut,
      srmSource,
    },
  };
}

/** Rebuild dashboard/results.json from dashboard/sites/*.json. Does not send traffic. */
export function rebuildFleetFromSiteDocs(): ReturnType<typeof buildFleetDocument> {
  const aggregationCommitSha = gitCommitSha();
  const rows: SiteRow[] = [];
  for (const site of SITES) {
    const path = resultsPath(site.id);
    if (!existsSync(path)) {
      throw new Error(`Missing site dashboard ${path}; run the fleet or a site experiment first.`);
    }
    const enriched = enrichSiteDocument(readSiteDoc(path));
    writeFileSync(path, `${JSON.stringify(enriched, null, 2)}\n`);
    const row = siteRowFromDocument(enriched);
    row.name = site.name;
    rows.push(row);
  }
  const fleetDoc = buildFleetDocument(
    rows,
    estimateFleetCalls(SITES.length, FLEET_ARM_N),
    "rebuild",
    aggregationCommitSha,
  );
  const path = fleetResultsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(fleetDoc, null, 2)}\n`);
  process.stdout.write(`Wrote fleet dashboard ${path}\n${fleetDoc.headline.copy}\n`);
  return fleetDoc;
}
