import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PatchSpec } from "../../shared/patch-spec.ts";
import { serveSites } from "../../agent/src/serve.ts";
import { runAnalyst } from "./agents/analyst.ts";
import { assertApproveArgs, pauseForHumanApproval, requireTypedApproval } from "./agents/approval.ts";
import {
  cleanupOrchFlags,
  loadFlagSetupFromExperiment,
  pauseExperiment,
  runFlagAgent,
} from "./agents/flag.ts";
import { runGatekeeper } from "./agents/gatekeeper.ts";
import { runMutator } from "./agents/mutator.ts";
import { runRollout } from "./agents/rollout.ts";
import { runScanner } from "./agents/scanner.ts";
import { runTrafficAgent } from "./agents/traffic.ts";
import { FlagsmithHttp } from "./flagsmith/http.ts";
import { fetchExperimentResults, resultsIdentityCount, waitForResults } from "./flagsmith/results.ts";
import { EventLog } from "./log.ts";
import { assertAllowedUrl } from "./loopback.ts";
import { statePath } from "./paths.ts";
import { writePassedSpecs } from "./specs.ts";
import { formatDuration, measureTimeSaved, TIME_SAVED_LABEL } from "./time-saved.ts";
import { startUiServer, type UiServer } from "./ui-server.ts";
import type {
  AnalystRecommendation,
  FlagSetup,
  GenerationRecord,
  GateResult,
  OrchOptions,
  PersistedState,
  TrafficVisit,
} from "./types.ts";

function saveState(state: PersistedState): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function flagsmithHttp(opts: OrchOptions): FlagsmithHttp {
  return new FlagsmithHttp({
    baseUrl: opts.adminApiUrl || opts.apiUrl,
    token: opts.adminToken,
  });
}

/** Gen-1 champion for L2: Flagsmith winner only. No axe-hit fallback. */
export function pickChampion(generation: GenerationRecord): PatchSpec | null {
  const rec = generation.recommendation;
  if (rec?.kind !== "winner") return null;
  if (rec.arm === "control" || rec.arm === generation.flag?.controlKey) {
    return generation.controlSpec;
  }
  return generation.passed.find((item) => item.specId === rec.arm)?.spec ?? null;
}

async function collectUntilWinner(
  opts: OrchOptions,
  flag: FlagSetup,
  passed: GateResult[],
  controlSpec: PatchSpec | null,
  log: EventLog,
): Promise<{ visits: TrafficVisit[]; recommendation: AnalystRecommendation }> {
  let visits = await runTrafficAgent(opts, flag, passed, controlSpec, log);
  log.setPhase("analysing");
  let minIdentities = Math.max(50, Math.floor(visits.length * 0.4));
  let results = await waitForResults(opts, flag.experimentId, opts.resultsWaitMs, undefined, minIdentities);
  let recommendation = runAnalyst(results, log, opts.threshold);
  const maxExtra = Math.max(0, Math.floor(Number(process.env.LIFT_ORCH_MAX_EXTRA_ROUNDS ?? 6)));
  let extra = 0;
  while (recommendation.kind !== "winner" && extra < maxExtra) {
    extra += 1;
    log.emit(
      "traffic",
      "info",
      `Keep collecting (extra round ${extra}/${maxExtra}): sending ${opts.trafficN} more SIMULATED visits`,
    );
    log.setPhase("traffic");
    const more = await runTrafficAgent(opts, flag, passed, controlSpec, log);
    visits = visits.concat(more);
    log.setPhase("analysing");
    minIdentities = resultsIdentityCount(results) + 1;
    results = await waitForResults(opts, flag.experimentId, opts.resultsWaitMs, undefined, minIdentities);
    recommendation = runAnalyst(results, log, opts.threshold);
  }
  return { visits, recommendation };
}

export async function runOrchestrator(opts: OrchOptions): Promise<PersistedState> {
  const started = Date.now();
  const log = new EventLog();
  assertAllowedUrl(opts.siteUrl, opts.allowRemote, "site URL");
  assertAllowedUrl(opts.apiUrl, opts.allowRemote, "FLAGSMITH_API_URL");
  assertAllowedUrl(opts.adminApiUrl, opts.allowRemote, "FLAGSMITH_ADMIN_API_URL");
  assertAllowedUrl(opts.eventsUrl, opts.allowRemote, "FLAGSMITH_EVENTS_URL");

  if (opts.cleanup) {
    log.emit("conductor", "start", `Cleanup flags with prefix lift_orch_`);
    const removed = await cleanupOrchFlags(opts, log);
    const state: PersistedState = {
      phase: "complete",
      siteUrl: opts.siteUrl,
      flagName: opts.flagName,
      metricEvent: opts.metricEvent,
      threshold: opts.threshold,
      generations: [],
      events: log.events,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date().toISOString(),
      timeSaved: measureTimeSaved(Date.now() - started),
    };
    log.emit("conductor", "done", `Deleted ${removed.length} lift_orch_ flags`);
    saveState(state);
    return state;
  }

  let ui: UiServer | undefined;
  if (!opts.noUi) {
    ui = await startUiServer(log, opts.uiPort);
    log.emit("conductor", "info", `Timeline UI ${ui.url}`);
  }

  if (opts.approve) {
    try {
      return await approveExisting(opts, log, started);
    } finally {
      if (ui && !opts.keepUi) await ui.close();
    }
  }

  const sitePort = Number(new URL(opts.siteUrl).port || 4174);
  process.env.LIFT_ORCH_FLAG = opts.flagName;
  const site = await serveSites(sitePort, { allowMock: true });
  if (site.reused && opts.apply) {
    if (ui && !opts.keepUi) await ui.close();
    throw new Error(
      `Site port ${sitePort} already in use. Stop the existing server so /orch-specs overlay can be served.`,
    );
  }

  const startedExperiments: Array<{ id: number; envKey: string }> = [];
  let failed = true;
  try {

    log.emit("conductor", "start", opts.apply ? "Apply mode" : "Dry-run (pass --apply to mutate Flagsmith)");
    const generations: GenerationRecord[] = [];
    let previousChampion: PatchSpec | null = null;
    let previousFlag: FlagSetup | undefined;

    for (let generation = 1; generation <= opts.generations; generation += 1) {
      if (generation >= 2) {
        if (!previousChampion || !previousFlag) {
          throw new Error("Generation 2 requires a Flagsmith winner from generation 1 (no axe-hit fallback).");
        }
        if (opts.apply && !previousFlag.dryRun && opts.environmentKey) {
          await pauseExperiment(flagsmithHttp(opts), opts.environmentKey, previousFlag.experimentId, log);
          log.emit(
            "conductor",
            "info",
            `Paused gen-${generation - 1} experiment ${previousFlag.experimentId} before generation ${generation}`,
          );
        }
      }

      log.setPhase("scanning");
      log.emit("conductor", "info", `Generation ${generation}/${opts.generations}`);
      const scan = await runScanner(opts.siteUrl, log);

      log.setPhase("mutating");
      const candidates = await runMutator(scan.axe, log, {
        generation,
        champion: generation === 1 ? null : previousChampion,
      });

      log.setPhase("gating");
      const gated = await runGatekeeper(
        opts.siteUrl,
        candidates,
        scan.axe,
        log,
        undefined,
        generation >= 2 ? previousChampion : null,
      );
      const passed = gated.filter((item) => item.passed);
      const rejected = gated.filter((item) => !item.passed);
      if (passed.length === 0) {
        log.setPhase("aborted");
        log.emit("conductor", "error", "No axe-gated variants. Refusing to send traffic.");
        const aborted: PersistedState = {
          phase: "aborted",
          siteUrl: opts.siteUrl,
          flagName: opts.flagName,
          metricEvent: opts.metricEvent,
          threshold: opts.threshold,
          generations: [
            ...generations,
            { generation, scan, candidates, gated, passed, rejected, controlSpec: previousChampion },
          ],
          events: log.events,
          startedAt: new Date(started).toISOString(),
          finishedAt: new Date().toISOString(),
          timeSaved: measureTimeSaved(Date.now() - started),
        };
        saveState(aborted);
        log.snapshot = aborted;
        log.writeLive();
        failed = false;
        return aborted;
      }

      const controlKey = "control";
      const controlSpec = generation === 1 ? null : previousChampion;
      writePassedSpecs(passed, controlSpec);
      process.env.LIFT_ORCH_FLAG = generation === 1 ? opts.flagName : `${opts.flagName}_g${generation}`;

      log.setPhase("flagging");
      const flag = await runFlagAgent(opts, passed, generation, controlKey, log);
      if (opts.apply && !flag.dryRun) {
        startedExperiments.push({ id: flag.experimentId, envKey: opts.environmentKey });
      }

      let visits: TrafficVisit[] | undefined;
      let recommendation: AnalystRecommendation | undefined;
      if (opts.apply && !flag.dryRun) {
        log.setPhase("traffic");
        const collected = await collectUntilWinner(opts, flag, passed, controlSpec, log);
        visits = collected.visits;
        recommendation = collected.recommendation;
      } else {
        log.emit("conductor", "info", "Skipping traffic and analyst (dry-run)");
      }

      const record: GenerationRecord = {
        generation,
        scan,
        candidates,
        gated,
        passed,
        rejected,
        controlSpec,
        flag,
        visits,
        recommendation,
      };
      generations.push(record);
      previousChampion = pickChampion(record);
      previousFlag = flag;
      log.snapshot = {
        generations,
        flag,
        recommendation,
        dashboardExperimentUrl: flag.dashboardUrl,
      };
      log.writeLive();
    }

    const last = generations[generations.length - 1];
    const paused = pauseForHumanApproval(log, {
      generation: last.generation,
      passed: last.passed,
      rejected: last.rejected,
      flag: last.flag,
      recommendation: last.recommendation,
    });
    const timeSaved = measureTimeSaved(Date.now() - started);
    log.emit(
      "conductor",
      "done",
      `Wall-clock ${formatDuration(timeSaved.wallClockMs)} ${TIME_SAVED_LABEL}. Saved ${formatDuration(timeSaved.savedMs)}.`,
    );
    const state: PersistedState = {
      phase: paused.phase,
      siteUrl: opts.siteUrl,
      flagName: opts.flagName,
      metricEvent: opts.metricEvent,
      threshold: opts.threshold,
      generations,
      events: log.events,
      recommendation: last.recommendation,
      flag: last.flag,
      timeSaved,
      dashboardExperimentUrl: last.flag?.dashboardUrl,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date().toISOString(),
    };
    saveState(state);
    log.snapshot = state;
    log.writeLive();
    failed = false;
    return state;
  } finally {
    if (failed && opts.apply) {
      for (const exp of startedExperiments) {
        try {
          await pauseExperiment(flagsmithHttp(opts), exp.envKey, exp.id, log);
          log.emit("conductor", "warn", `Paused experiment ${exp.id} after a crash`);
        } catch {
          log.emit("conductor", "warn", `Could not pause experiment ${exp.id} after a crash`);
        }
      }
    }
    if (!site.reused) await site.close();
    if (ui && !opts.keepUi) await ui.close();
  }
}

async function approveExisting(
  opts: OrchOptions,
  log: EventLog,
  started: number,
): Promise<PersistedState> {
  assertApproveArgs(opts.approve, opts.approveExperimentId);
  const experimentId = opts.approveExperimentId as number;
  await requireTypedApproval(experimentId);
  const http = flagsmithHttp(opts);
  const flag = await loadFlagSetupFromExperiment(opts, experimentId, http);
  log.emit("approval", "info", `Re-fetching Flagsmith /results for experiment ${experimentId}`);
  const results = await fetchExperimentResults(opts, experimentId, true, http);
  const recommendation = runAnalyst(results, log, opts.threshold);
  if (recommendation.kind !== "winner") {
    throw new Error(
      recommendation.kind === "keep_collecting"
        ? recommendation.reason
        : "Flagsmith /results did not recommend a winner",
    );
  }
  log.setPhase("rolling_out");
  const result = await runRollout(opts, flag, recommendation, log, http);
  const timeSaved = measureTimeSaved(Date.now() - started);
  const state: PersistedState = {
    phase: "complete",
    siteUrl: opts.siteUrl,
    flagName: flag.flagName,
    metricEvent: opts.metricEvent,
    threshold: opts.threshold,
    generations: [],
    events: log.events,
    recommendation,
    flag,
    timeSaved,
    dashboardExperimentUrl: flag.dashboardUrl,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
  };
  log.setPhase("complete");
  log.emit("conductor", "done", `Rolled out ${result.winner}. Experiment ${result.experimentId} completed.`);
  saveState(state);
  log.snapshot = state;
  log.writeLive();
  return state;
}

/** Scan + mutate + gate only. Used by e2e tests. */
export async function runScanMutateGate(siteUrl: string): Promise<{
  gated: GateResult[];
  passed: GateResult[];
  rejected: GateResult[];
}> {
  const log = new EventLog(false);
  const scan = await runScanner(siteUrl, log);
  const candidates = await runMutator(scan.axe, log);
  const gated = await runGatekeeper(siteUrl, candidates, scan.axe, log);
  return {
    gated,
    passed: gated.filter((item) => item.passed),
    rejected: gated.filter((item) => !item.passed),
  };
}
