import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SITES } from "../../shared/catalog.ts";
import { siteRowFromDocument, type SiteRow } from "../../shared/aggregate.ts";
import { gitCommitSha } from "../../shared/git.ts";
import { FLEET_ARM_N, estimateFleetCalls } from "../../shared/estimate.ts";
import { fleetResultsPath, loadConfig, readJson, resultsPath } from "./config.ts";
import {
  buildFleetDocument,
  rebuildFleetFromSiteDocs,
} from "./fleet-document.ts";
import { runExperiment } from "./run.ts";
import { serveSites } from "./serve.ts";

export { estimateFleetCalls, FLEET_ARM_N, buildFleetDocument, rebuildFleetFromSiteDocs };

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
  const sha = gitCommitSha();
  try {
    for (const site of SITES) {
      process.stdout.write(`\n=== ${site.id} (${site.flagName}) ===\n`);
      const existingPath = resultsPath(site.id);
      if (existsSync(existingPath) && process.env.LIFT_FLEET_FORCE !== "true") {
        const existing = readJson<Parameters<typeof siteRowFromDocument>[0]>(existingPath);
        if (existing?.decision) {
          const row = siteRowFromDocument(existing);
          row.name = site.name;
          row.producedBy = "reused";
          row.commitSha = existing.commitSha ?? sha;
          rows.push(row);
          process.stdout.write(`Reusing ${existingPath}\n`);
          continue;
        }
      }
      process.env.LIFT_SITE = site.id;
      process.env.LIFT_FLAG_NAME = site.flagName;
      process.env.LIFT_METRIC_EVENT = site.metricEvent;
      process.env.LIFT_SITE_URL = `http://127.0.0.1:${port}/${site.id}`;
      process.env.LIFT_STATE_PATH = "";
      const doc = await runExperiment();
      const row = siteRowFromDocument({ ...doc, producedBy: "fleet", commitSha: sha });
      row.name = site.name;
      row.producedBy = "fleet";
      row.commitSha = sha;
      rows.push(row);
    }
  } finally {
    if (!server.reused) await server.close();
  }

  const fleetDoc = buildFleetDocument(rows, estimate, "fleet", sha);
  const path = fleetResultsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(fleetDoc, null, 2)}\n`);
  process.stdout.write(`Wrote fleet dashboard ${path}\n${fleetDoc.headline.copy}\n`);
  return fleetDoc;
}

async function main() {
  if (process.argv.includes("--estimate")) {
    process.stdout.write(`${JSON.stringify(estimateFleetCalls(), null, 2)}\n`);
    return;
  }
  if (process.argv.includes("--rebuild")) {
    rebuildFleetFromSiteDocs();
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
