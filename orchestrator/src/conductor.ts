import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PatchSpec } from "../../shared/patch-spec.ts";
import { serveSites } from "../../agent/src/serve.ts";
import { runAnalyst } from "./agents/analyst.ts";
import { assertCanApprove, pauseForHumanApproval } from "./agents/approval.ts";
import { runFlagAgent } from "./agents/flag.ts";
import { runGatekeeper } from "./agents/gatekeeper.ts";
import { runMutator } from "./agents/mutator.ts";
import { runRollout } from "./agents/rollout.ts";
import { runScanner } from "./agents/scanner.ts";
import { runTrafficAgent } from "./agents/traffic.ts";
import { waitForResults } from "./flagsmith/results.ts";
import { EventLog } from "./log.ts";
import { assertAllowedUrl } from "./loopback.ts";
import { STATE_PATH } from "./paths.ts";
import { formatDuration, measureTimeSaved } from "./time-saved.ts";
import { startUiServer, type UiServer } from "./ui-server.ts";
import type {
  GenerationRecord,
  GateResult,
  OrchOptions,
  PersistedState,
} from "./types.ts";

function loadState(): PersistedState | null {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as PersistedState;
  } catch {
    return null;
  }
}

function saveState(state: PersistedState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

/** Gen-1 champion for L2: Flagsmith winner if one exists, else the fewest remaining axe hits. */
export function pickChampion(generation: GenerationRecord): PatchSpec | null {
  const rec = generation.recommendation;
  if (rec?.kind === "winner") {
    if (rec.arm === "control" || rec.arm === generation.flag?.controlKey) {
      return generation.controlSpec;
    }
    return generation.passed.find((item) => item.specId === rec.arm)?.spec ?? generation.passed[0]?.spec ?? null;
  }
  const ranked = [...generation.passed].sort((a, b) => {
    const rules = a.after.violationCount - b.after.violationCount;
    if (rules !== 0) return rules;
    return a.after.nodeCount - b.after.nodeCount;
  });
  return ranked[0]?.spec ?? null;
}

export async function runOrchestrator(opts: OrchOptions): Promise<PersistedState> {
  const started = Date.now();
  const log = new EventLog();
  assertAllowedUrl(opts.siteUrl, opts.allowRemote, "site URL");
  assertAllowedUrl(opts.apiUrl, opts.allowRemote, "FLAGSMITH_API_URL");

  let ui: UiServer | undefined;
  if (!opts.noUi) {
    ui = await startUiServer(log, opts.uiPort);
    log.emit("conductor", "info", `Timeline UI ${ui.url}`);
  }

  const sitePort = Number(new URL(opts.siteUrl).port || 4174);
  const site = await serveSites(sitePort, { allowMock: true });

  try {
    if (opts.approve) {
      return await approveExisting(opts, log, started);
    }

    log.emit("conductor", "start", opts.apply ? "Apply mode" : "Dry-run (pass --apply to mutate Flagsmith)");
    const generations: GenerationRecord[] = [];
    let previousChampion: PatchSpec | null = null;

    for (let generation = 1; generation <= opts.generations; generation += 1) {
      log.setPhase("scanning");
      log.emit("conductor", "info", `Generation ${generation}/${opts.generations}`);
      const scan = await runScanner(opts.siteUrl, log);

      log.setPhase("mutating");
      const candidates = await runMutator(scan.axe, log, {
        generation,
        champion: generation === 1 ? null : previousChampion,
      });

      log.setPhase("gating");
      const gated = await runGatekeeper(opts.siteUrl, candidates, scan.axe, log);
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
          generations: [...generations, { generation, scan, candidates, gated, passed, rejected, controlSpec: previousChampion }],
          events: log.events,
          startedAt: new Date(started).toISOString(),
          finishedAt: new Date().toISOString(),
          timeSaved: measureTimeSaved(Date.now() - started),
        };
        saveState(aborted);
        log.snapshot = aborted;
        log.writeLive();
        return aborted;
      }

      const controlKey = "control";
      const controlSpec = generation === 1 ? null : previousChampion;

      log.setPhase("flagging");
      const flag = await runFlagAgent(opts, passed, generation, controlKey, log);

      let visits = undefined;
      let recommendation = undefined;
      if (opts.apply && !flag.dryRun) {
        log.setPhase("traffic");
        visits = await runTrafficAgent(opts, flag, passed, controlSpec, log);
        log.setPhase("analysing");
        const results = await waitForResults(opts, flag.experimentId, opts.resultsWaitMs);
        recommendation = runAnalyst(results, log, opts.threshold);
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
      `Wall-clock ${formatDuration(timeSaved.wallClockMs)} vs manual ${timeSaved.manualEstimateMinutes} min. Saved ${formatDuration(timeSaved.savedMs)}.`,
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
    return state;
  } finally {
    if (!site.reused) await site.close();
    if (ui && !opts.keepUi) await ui.close();
  }
}

async function approveExisting(
  opts: OrchOptions,
  log: EventLog,
  started: number,
): Promise<PersistedState> {
  const existing = loadState();
  if (!existing) {
    throw new Error("No orchestrator state to approve. Run without --approve first.");
  }
  log.events.push(...existing.events);
  log.phase = existing.phase;
  log.snapshot = existing;
  assertCanApprove(existing.phase, true);
  if (!existing.flag || !existing.recommendation) {
    throw new Error("State has no flag/recommendation to roll out. Re-run with --apply first.");
  }
  if (existing.recommendation.kind !== "winner") {
    throw new Error(existing.recommendation.reason);
  }
  log.setPhase("rolling_out");
  const result = await runRollout(opts, existing.flag, existing.recommendation, log);
  const timeSaved = measureTimeSaved(Date.now() - started);
  const state: PersistedState = {
    ...existing,
    phase: "complete",
    events: log.events,
    timeSaved,
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
