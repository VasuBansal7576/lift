import { loadConfig } from "./config.ts";
import { rebuildFleetFromSiteDocs } from "./fleet-document.ts";
import { loadRunningState } from "./bootstrap.ts";
import {
  applyDecision,
  decideExperiment,
  parseFlagsmithWin,
  summariseVisits,
  waitForFlagsmithResults,
  loadVisits,
} from "./decide.ts";
import { buildResultsDocument, flagsmithArmCounts, writeDashboard } from "./dashboard.ts";
import { scanSite } from "./scan.ts";
import { serveSites } from "./serve.ts";
import { runTraffic } from "../../traffic/src/runner.ts";
import { getSite } from "../../shared/catalog.ts";

export async function runExperiment() {
  const cfg = loadConfig();
  const site = getSite(cfg.siteId);
  const scan = scanSite(cfg.siteId);
  process.stdout.write(
    `Fixture scan (${site.id}): ${scan.findings.length} data-barrier markers (${scan.findings.map((f) => f.barrier.id).join(", ")}). Not a production crawler.\n`,
  );

  const state = await loadRunningState(cfg);
  process.stdout.write(
    `Flagsmith experiment ${state.experimentId} on flag ${state.flagName}\n`,
  );

  const sitePort = Number(new URL(cfg.siteUrl).port || 4174);
  const server = await serveSites(sitePort);
  try {
    if (cfg.continueUntilDecision) {
      process.stderr.write(
        "LIFT_CONTINUE_UNTIL=true is optional stopping: extra batches are sent until P(win) crosses the threshold. Prefer a pre-registered fixed horizon (LIFT_TARGET_ARM_N).\n",
      );
    }
    let batch = 0;
    for (;;) {
      const runId = `${cfg.trafficRunId}-b${batch}`;
      const n = cfg.continueUntilDecision
        ? cfg.trafficN
        : Math.max(cfg.trafficN, cfg.targetArmN * 2);
      await runTraffic({
        trafficRunId: runId,
        trafficN: n,
        trafficBatch: batch,
        appendVisits: cfg.appendVisits || (cfg.continueUntilDecision && batch > 0),
      });
      batch += 1;

      const visits = loadVisits();
      const trafficEndedAt = visits.at(-1)?.at ?? new Date().toISOString();
      const waitMs = Math.max(cfg.resultsWaitMs, cfg.continueUntilDecision ? 5 * 60 * 1000 : 0);
      const flagsmith = await waitForFlagsmithResults({
        experimentId: state.experimentId,
        visits,
        waitMs,
        trafficEndedAt,
      });
      const local = summariseVisits(visits);
      const parsed = parseFlagsmithWin(flagsmith, {
        localN: visits.length,
        localArms: {
          control: local.control.visitors,
          treatment: local.treatment.visitors,
        },
        trafficEndedAt,
      });
      const decision = decideExperiment({
        flag: cfg.flagName,
        visits,
        flagsmith,
        threshold: cfg.winThreshold,
        allowLocalDecision: cfg.allowLocalDecision,
        statsSeed: cfg.trafficSeed,
        trafficEndedAt,
      });

      const arms = flagsmithArmCounts(flagsmith);
      const maxArm = Math.max(
        arms?.control.visitors ?? 0,
        arms?.treatment.visitors ?? 0,
        local.control.visitors,
        local.treatment.visitors,
      );
      const flagsmithReady = parsed?.usable === true;
      const conclusive = flagsmithReady && decision.decision !== "keep_running";
      const atCap = maxArm >= cfg.maxArmN;
      const sendMore =
        cfg.continueUntilDecision &&
        !conclusive &&
        !atCap &&
        parsed?.rejectReason !== "srm" &&
        parsed?.rejectReason !== "ingestion";
      process.stdout.write(
        `batch=${batch} waitMs=${waitMs} visits=${visits.length} parsed=${parsed?.rejectReason ?? (flagsmithReady ? "usable" : "none")} source=${decision.source} decision=${decision.decision} maxArm=${maxArm} cap=${cfg.maxArmN} sendMore=${sendMore}\n`,
      );

      if (sendMore) {
        process.stdout.write(
          `Optional stopping: not conclusive at maxArm=${maxArm} (cap ${cfg.maxArmN}); sending another batch.\n`,
        );
        continue;
      }

      const verification = await applyDecision(decision);
      const doc = buildResultsDocument({
        decision,
        visits,
        flagsmith,
        experimentId: state.experimentId,
        dashboardUrl: `${cfg.dashboardUrl}/project/${state.projectId}/environment/${state.environmentId}/experiments/${state.experimentId}`,
        personaMix: cfg.personaMix,
        site: site.id,
        verification,
        producedBy: process.env.LIFT_FLEET === "true" ? "fleet" : "experiment",
      });
      const path = writeDashboard(doc);
      if (process.env.LIFT_FLEET !== "true") {
        rebuildFleetFromSiteDocs();
        process.stdout.write(`Wrote ${path} and rebuilt dashboard/results.json from sites/*.json\n`);
      } else {
        process.stdout.write(`Wrote ${path}\n`);
      }
      process.stdout.write(
        `${decision.decision} (${decision.source}, P(treatment>control)=${decision.winProbabilityTreatment.toFixed(3)})\n`,
      );
      return doc;
    }
    throw new Error("experiment loop exited without a decision");
  } finally {
    if (!server.reused) await server.close();
  }
}

async function main() {
  await runExperiment();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : err}\n`);
    process.exit(1);
  });
}

