import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PatchSpec } from "../../shared/patch-spec.ts";
import { serveSites } from "../../agent/src/serve.ts";
import { formatGen2Inconclusive, runAnalyst } from "./agents/analyst.ts";
import {
  assertApproveArgs,
  pauseForHumanApproval,
  requireTypedApproval,
  type ApprovalIo,
} from "./agents/approval.ts";
import {
  cleanupOrchFlags,
  controlArmLabel,
  loadFlagSetupFromExperiment,
  pauseExperiment,
  runFlagAgent,
} from "./agents/flag.ts";
import { runGatekeeper } from "./agents/gatekeeper.ts";
import { championFocusCeilingNote, runMutator } from "./agents/mutator.ts";
import { runRollout } from "./agents/rollout.ts";
import { runScanner } from "./agents/scanner.ts";
import { runTrafficAgent } from "./agents/traffic.ts";
import { FlagsmithHttp } from "./flagsmith/http.ts";
import {
  fetchExperimentResults,
  resultsAreReady,
  resultsIdentityCount,
  waitForResults,
} from "./flagsmith/results.ts";
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

function loadPersistedState(): PersistedState | null {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8")) as PersistedState;
  } catch {
    return null;
  }
}

export function extraRoundsFromEnv(raw = process.env.LIFT_ORCH_MAX_EXTRA_ROUNDS): number {
  if (raw == null || String(raw).trim() === "") return 0;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

export function identitiesNeeded(visits: number, extraRounds: number): number {
  if (extraRounds === 0) return Math.max(50, Math.ceil(visits * 0.98));
  return Math.max(50, Math.floor(visits * 0.4));
}

export function trafficNForGeneration(opts: OrchOptions, generation: number): number {
  if (generation >= 2) {
    const raw = process.env.LIFT_ORCH_TRAFFIC_N_GEN2?.trim();
    if (raw) {
      const n = Math.floor(Number(raw));
      if (Number.isFinite(n) && n >= 4) return n;
    }
  }
  return opts.trafficN;
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
  const maxExtra = extraRoundsFromEnv();
  let minIdentities = identitiesNeeded(visits.length, maxExtra);
  log.emit(
    "analyst",
    "info",
    `Waiting for Flagsmith identities >= ${minIdentities} (visits=${visits.length}, extraRounds=${maxExtra})`,
  );
  let results = await waitForResults(opts, flag.experimentId, opts.resultsWaitMs, undefined, minIdentities);
  let recommendation = runAnalyst(results, log, opts.threshold);
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
    const previousCount = resultsIdentityCount(results);
    minIdentities = resultsAreReady(results, 0)
      ? previousCount + 1
      : Math.max(identitiesNeeded(visits.length, maxExtra), previousCount);
    results = await waitForResults(opts, flag.experimentId, opts.resultsWaitMs, undefined, minIdentities);
    recommendation = runAnalyst(results, log, opts.threshold);
  }
  return { visits, recommendation };
}

export interface RunOrchestratorExtras {
  approvalIo?: ApprovalIo;
}

export async function runOrchestrator(
  opts: OrchOptions,
  extras: RunOrchestratorExtras = {},
): Promise<PersistedState> {
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

  if (opts.resultsExperimentId) {
    return printExperimentResults(opts, log, started);
  }

  let ui: UiServer | undefined;
  if (!opts.noUi) {
    ui = await startUiServer(log, opts.uiPort);
    log.emit("conductor", "info", `Timeline UI ${ui.url}`);
  }

  if (opts.approve) {
    try {
      return await approveExisting(opts, log, started, extras.approvalIo);
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
    const startGen = Math.max(1, Math.min(opts.generations, opts.fromGeneration || 1));
    if (startGen >= 2) {
      const previous = loadPersistedState();
      if (!previous?.generations?.length) {
        throw new Error("--from-generation requires run-state.json from a prior generation");
      }
      generations.push(...previous.generations.filter((item) => item.generation < startGen));
      const last = generations[generations.length - 1];
      previousChampion = last ? pickChampion(last) : null;
      previousFlag = last?.flag;
      if (!previousChampion || !previousFlag) {
        throw new Error(`Generation ${startGen} requires a Flagsmith winner from generation ${startGen - 1}`);
      }
      log.emit(
        "conductor",
        "info",
        `Resuming at generation ${startGen}; champion ${previousChampion.id} from experiment ${previousFlag.experimentId}`,
      );
    }

    for (let generation = startGen; generation <= opts.generations; generation += 1) {
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
        log.emit(
          "conductor",
          "info",
          `${controlArmLabel(generation, previousChampion.id)} (payload key remains "control")`,
        );
        log.emit("conductor", "info", championFocusCeilingNote(previousChampion));
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
      process.env.LIFT_ORCH_CONTROL_SPEC = generation >= 2 ? "1" : "";
      writePassedSpecs(passed, controlSpec);
      process.env.LIFT_ORCH_FLAG = generation === 1 ? opts.flagName : `${opts.flagName}_g${generation}`;

      log.setPhase("flagging");
      const flag = await runFlagAgent(opts, passed, generation, controlKey, log, {
        championId: previousChampion?.id,
      });
      site.setAllowMock(false);
      log.snapshot = {
        generations,
        flag,
        dashboardExperimentUrl: flag.dashboardUrl,
      };
      log.writeLive();
      if (opts.apply && !flag.dryRun) {
        startedExperiments.push({ id: flag.experimentId, envKey: opts.environmentKey });
      }

      let visits: TrafficVisit[] | undefined;
      let recommendation: AnalystRecommendation | undefined;
      if (opts.apply && !flag.dryRun) {
        const genOpts = { ...opts, trafficN: trafficNForGeneration(opts, generation) };
        if (generation >= 2) {
          log.emit(
            "conductor",
            "info",
            `gen-2 traffic-n ${genOpts.trafficN} (fixed horizon, disclosed)`,
          );
        }
        log.setPhase("traffic");
        const collected = await collectUntilWinner(genOpts, flag, passed, controlSpec, log);
        visits = collected.visits;
        recommendation = collected.recommendation;
        if (generation === 1 && recommendation.kind === "winner") {
          log.emit(
            "conductor",
            "info",
            `gen-1 champion ${recommendation.arm} chance_to_win=${recommendation.chanceToWin.toFixed(3)}`,
          );
        }
        if (generation >= 2 && recommendation.kind === "keep_collecting") {
          log.emit("analyst", "wait", formatGen2Inconclusive(recommendation, visits.length));
        }
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
      site.setAllowMock(true);
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
  approvalIo?: ApprovalIo,
): Promise<PersistedState> {
  assertApproveArgs(opts.approve, opts.approveExperimentId);
  const experimentId = opts.approveExperimentId as number;
  await requireTypedApproval(experimentId, approvalIo);
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

export async function printExperimentResults(
  opts: OrchOptions,
  log: EventLog,
  started = Date.now(),
): Promise<PersistedState> {
  const experimentId = opts.resultsExperimentId as number;
  if (!Number.isInteger(experimentId) || experimentId <= 0) {
    throw new Error("--results requires a positive experiment id");
  }
  log.emit("analyst", "start", `CLI --results ${experimentId}`);
  const envelope = await fetchExperimentResults(opts, experimentId, true);
  const recommendation = runAnalyst(envelope, log, opts.threshold);
  for (const arm of recommendation.arms) {
    const n = arm.n ?? "n/a";
    const sum = arm.sum ?? "n/a";
    log.emit(
      "analyst",
      "info",
      `${arm.key} n=${n} sum=${sum} chance_to_win=${arm.chanceToWin.toFixed(3)}`,
    );
  }
  const timeSaved = measureTimeSaved(Date.now() - started);
  const state: PersistedState = {
    phase: recommendation.kind === "winner" ? "WAITING_FOR_HUMAN_APPROVAL" : "KEEP_COLLECTING",
    siteUrl: opts.siteUrl,
    flagName: opts.flagName,
    metricEvent: opts.metricEvent,
    threshold: opts.threshold,
    generations: [],
    events: log.events,
    recommendation,
    timeSaved,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
  };
  log.setPhase(state.phase);
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
