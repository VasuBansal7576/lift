import { getSite } from "../../shared/catalog.ts";
import { loadConfig, readJson, statePath } from "./config.ts";
import type { BootstrapState } from "./bootstrap.ts";
import {
  decideExperiment,
  evaluateIdentityVariant,
  loadVisits,
  setEnvironmentDefault,
  variantMatches,
  waitForFlagsmithResults,
  type RolloutVerification,
} from "./decide.ts";
import { FlagsmithAdmin } from "./flagsmith-admin.ts";
import { buildResultsDocument, writeDashboard } from "./dashboard.ts";

const VERIFY_N = 20;

/** Write dashboard results for a site whose experiment already completed. */
export async function snapshotSite() {
  const cfg = loadConfig();
  const site = getSite(cfg.siteId);
  const state = readJson<BootstrapState>(statePath(cfg.siteId));
  if (!state) {
    throw new Error(`No bootstrap state at ${statePath(cfg.siteId)}`);
  }
  const visits = loadVisits();
  const flagsmith = await waitForFlagsmithResults({
    experimentId: state.experimentId,
    visits,
    waitMs: Math.min(cfg.resultsWaitMs, 120_000),
    trafficEndedAt: visits.at(-1)?.at,
  });
  const decision = decideExperiment({
    flag: cfg.flagName,
    visits,
    flagsmith,
    threshold: cfg.winThreshold,
    allowLocalDecision: cfg.allowLocalDecision,
    statsSeed: cfg.trafficSeed,
    trafficEndedAt: visits.at(-1)?.at,
  });

  let verification: RolloutVerification = {
    applied: false,
    n: 0,
    matched: 0,
    expected: null,
    usedFallback: false,
  };
  if (decision.decision !== "keep_running") {
    const expected = decision.decision === "rollout_treatment" ? "treatment" : "control";
    const admin = new FlagsmithAdmin(cfg);
    await setEnvironmentDefault(
      admin,
      cfg.environmentKey,
      state.flagId,
      state.treatmentOptionId,
      expected,
    );
    let matched = 0;
    const stamp = Date.now();
    for (let i = 0; i < VERIFY_N; i += 1) {
      const got = await evaluateIdentityVariant(
        state.flagName,
        `lift-verify-snapshot-${stamp}-${i}`,
      );
      if (variantMatches(got, expected)) matched += 1;
    }
    if (matched !== VERIFY_N) {
      throw new Error(
        `Snapshot verify failed for ${site.id}: ${matched}/${VERIFY_N} identities matched ${expected}`,
      );
    }
    verification = {
      applied: true,
      n: VERIFY_N,
      matched,
      expected,
      usedFallback: true,
    };
  }

  const doc = buildResultsDocument({
    decision,
    visits,
    flagsmith,
    experimentId: state.experimentId,
    dashboardUrl: `${cfg.dashboardUrl}/project/${state.projectId}/environment/${state.environmentId}/experiments/${state.experimentId}`,
    personaMix: cfg.personaMix,
    site: site.id,
    verification,
  });
  const path = writeDashboard(doc);
  process.stdout.write(`Wrote ${path} for completed ${site.id} experiment ${state.experimentId}\n`);
  return doc;
}

async function main() {
  await snapshotSite();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : err}\n`);
    process.exit(1);
  });
}
