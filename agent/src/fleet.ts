import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SITES } from "../../shared/catalog.ts";
import {
  aggregateSites,
  decisionLabel,
  siteRowFromDocument,
  type SiteRow,
} from "../../shared/aggregate.ts";
import {
  estimateFleetCalls,
  FLEET_ARM_N,
  type FleetCallEstimate,
} from "../../shared/estimate.ts";
import { DEFAULT_PERSONA_MIX } from "../../shared/types.ts";
import { fleetResultsPath, loadConfig } from "./config.ts";
import { runExperiment } from "./run.ts";
import { serveSites } from "./serve.ts";

export { estimateFleetCalls, FLEET_ARM_N };

export function buildFleetDocument(rows: SiteRow[], estimate: FleetCallEstimate) {
  const mix = DEFAULT_PERSONA_MIX;
  const aggregate = aggregateSites(rows, mix);
  return {
    traffic: "simulated" as const,
    label:
      "SIMULATED TRAFFIC — Playwright persona bots, not humans. Demonstration of the pipeline; outcomes follow the persona model, not evidence about real users.",
    generatedAt: new Date().toISOString(),
    sites: rows.length,
    site: "fleet",
    personaMix: mix,
    estimate,
    aggregate,
    headline: {
      conversionLift: aggregate.medianLift,
      displayLift: aggregate.medianLift,
      source: "flagsmith" as const,
      copy: aggregate.headline,
      method: aggregate.method,
    },
    outcome: aggregate.explanation,
    honesty: aggregate.explanation,
    rows: rows.map((row) => ({
      ...row,
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
    })),
  };
}

export async function runFleet() {
  const estimate = estimateFleetCalls(SITES.length, FLEET_ARM_N);
  process.stdout.write(
    `Fleet estimate: ${estimate.sites} sites × ${estimate.armN}/arm = ${estimate.visitors} visits. ~${estimate.total} Flagsmith HTTP calls (${estimate.notes.join(" ")})\n`,
  );

  process.env.LIFT_TARGET_ARM_N = String(FLEET_ARM_N);
  process.env.LIFT_TRAFFIC_N = String(FLEET_ARM_N * 2);
  process.env.LIFT_CONTINUE_UNTIL = "false";
  process.env.LIFT_FLEET = "true";

  const cfg = loadConfig();
  const port = Number(new URL(cfg.siteUrl).port || 4174);
  const server = await serveSites(port);
  const rows: SiteRow[] = [];
  try {
    for (const site of SITES) {
      process.stdout.write(`\n=== ${site.id} (${site.flagName}) ===\n`);
      process.env.LIFT_SITE = site.id;
      process.env.LIFT_FLAG_NAME = site.flagName;
      process.env.LIFT_METRIC_EVENT = site.metricEvent;
      process.env.LIFT_SITE_URL = `http://127.0.0.1:${port}/${site.id}`;
      process.env.LIFT_STATE_PATH = "";
      const doc = await runExperiment();
      const row = siteRowFromDocument(doc);
      row.name = site.name;
      rows.push(row);
    }
  } finally {
    if (!server.reused) await server.close();
  }

  const fleetDoc = buildFleetDocument(rows, estimate);
  const path = fleetResultsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(fleetDoc, null, 2)}\n`);
  process.stdout.write(`Wrote fleet dashboard ${path}\n${fleetDoc.headline.copy}\n`);
  return fleetDoc;
}

async function main() {
  const dry = process.argv.includes("--estimate");
  if (dry) {
    process.stdout.write(`${JSON.stringify(estimateFleetCalls(), null, 2)}\n`);
    return;
  }
  await runFleet();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : err}\n`);
    process.exit(1);
  });
}
