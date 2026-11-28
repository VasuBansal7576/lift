import { existsSync, readFileSync } from "node:fs";
import { completeBody, experimentCreatePayload } from "../../agent/src/payloads.ts";
import { flagBool, flagString, type FlagMap } from "./args.ts";
import type { GateResult } from "./axe-gate.ts";
import type { ExperimentRecord, LiftSelfhost } from "./client.ts";
import { resultsPresent, CHANCE_TO_WIN_THRESHOLD, pickRolloutFromResults } from "./results.ts";
import { promptApproveLine, readTtyLine, type LineResult } from "./approve.ts";
import {
  assertSafeToMutate,
  wantAllowRemote,
  wantApply,
  wantConfirmProd,
} from "./safety.ts";

export interface MutationContext {
  environmentName: string;
  confirmProd: boolean;
  apply: boolean;
  allowRemote?: boolean;
  apiUrl?: string;
  adminApiUrl?: string;
  cliApiUrl?: string;
  eventsUrl?: string;
  gate?: GateResult | null;
}

export interface RolloutHooks {
  fetchResults?: (experimentId: number) => Promise<unknown>;
  complete?: (experimentId: number, body: Record<string, unknown>) => Promise<unknown>;
  pinTreatment?: (flagName: string, percent: number) => Promise<unknown>;
  getExperiment?: (experimentId: number) => Promise<ExperimentRecord>;
  findFeature?: (name: string) => Promise<{ id: number; name: string } | null>;
  readApprovalLine?: () => Promise<LineResult>;
}

export interface RecordedFlag {
  name: string;
  id: number;
}

export function recordedFlagsFromLastRun(path: string): RecordedFlag[] {
  if (!existsSync(path)) return [];
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as { createdFlags?: RecordedFlag[] };
    return Array.isArray(doc.createdFlags) ? doc.createdFlags : [];
  } catch {
    return [];
  }
}

export function mutationContext(
  flags: FlagMap,
  env: {
    environmentName: string;
    apiUrl: string;
    adminApiUrl: string;
    cliApiUrl: string;
    eventsUrl: string;
  },
  extra: Partial<MutationContext> = {},
): MutationContext {
  return {
    environmentName: flagString(flags, "environment-name", env.environmentName),
    confirmProd: wantConfirmProd({ "confirm-prod": flagBool(flags, "confirm-prod") }),
    apply: wantApply({ apply: flagBool(flags, "apply"), "dry-run": flagBool(flags, "dry-run") }),
    allowRemote: wantAllowRemote({ "allow-remote": flagBool(flags, "allow-remote") }),
    apiUrl: env.apiUrl,
    adminApiUrl: env.adminApiUrl,
    cliApiUrl: env.cliApiUrl,
    eventsUrl: env.eventsUrl,
    ...extra,
  };
}

export function planOrRefuse(ctx: MutationContext): Record<string, unknown> {
  const safety = assertSafeToMutate({
    environmentName: ctx.environmentName,
    confirmProd: ctx.confirmProd,
    apiUrl: ctx.apiUrl,
    adminApiUrl: ctx.adminApiUrl,
    cliApiUrl: ctx.cliApiUrl,
    eventsUrl: ctx.eventsUrl,
    allowRemote: ctx.allowRemote,
  });
  if (!safety.ok) return { ...safety, dryRun: !ctx.apply };
  if (!ctx.apply) return { ok: true, dryRun: true, planned: true };
  return { ok: true, dryRun: false };
}

/** Call once at the top of every --apply run. Weights must not change before this passes. */
export function guardApply(ctx: MutationContext): Record<string, unknown> {
  if (!ctx.apply) return { ok: true, dryRun: true };
  return planOrRefuse(ctx);
}

export function assertApprovalCommand(flags: FlagMap): { ok: true } | { ok: false; reason: string } {
  if (flagBool(flags, "approve-rollout")) {
    return {
      ok: false,
      reason: "--approve-rollout was removed; type APPROVE <experimentId> at the TTY prompt",
    };
  }
  return { ok: true };
}

export function canReuseExistingFlag(
  existing: { name: string; id: number } | null,
  opts: { reuseFlag?: boolean; recorded?: RecordedFlag[] } = {},
): { ok: true } | { ok: false; reason: string } {
  if (!existing) return { ok: true };
  if (opts.reuseFlag) return { ok: true };
  if (opts.recorded?.some((row) => row.name === existing.name && row.id === existing.id)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `flag ${existing.name} already exists (id=${existing.id}) and was not created in last-run.json; pass --reuse-flag`,
  };
}

export function experimentFeatureId(exp: {
  feature?: number | { id: number };
}): number | undefined {
  if (typeof exp.feature === "number") return exp.feature;
  if (exp.feature && typeof exp.feature === "object") return exp.feature.id;
  return undefined;
}

export function experimentIsRunning(status: string): boolean {
  return /running/i.test(status);
}

export async function assertApprovalTarget(
  lift: LiftSelfhost,
  opts: { flagName: string; experimentId: number },
  hooks: RolloutHooks = {},
): Promise<{ ok: true; experiment: ExperimentRecord } | { ok: false; reason: string }> {
  if (!opts.experimentId) {
    return { ok: false, reason: "approval requires --experiment-id" };
  }
  const experiment =
    (await hooks.getExperiment?.(opts.experimentId)) ?? (await lift.getExperiment(opts.experimentId));
  if (!experimentIsRunning(experiment.status ?? "")) {
    return {
      ok: false,
      reason: `experiment ${opts.experimentId} is not running (status=${experiment.status})`,
    };
  }
  const feature =
    (await hooks.findFeature?.(opts.flagName)) ?? (await lift.findFeature(opts.flagName));
  const featureId = experimentFeatureId(experiment);
  if (!feature || featureId !== feature.id) {
    return {
      ok: false,
      reason: `experiment ${opts.experimentId} does not belong to --flag ${opts.flagName}`,
    };
  }
  const raw =
    (await hooks.fetchResults?.(opts.experimentId)) ??
    (await lift.getExperimentResults(opts.experimentId));
  if (!resultsPresent(raw)) {
    return { ok: false, reason: `experiment ${opts.experimentId} has no results yet` };
  }
  return { ok: true, experiment };
}

export function assertServedVariants(opts: {
  flagName: string;
  control: { variant: string; status: string };
  treatment: { variant: string; status: string };
}): { ok: true } | { ok: false; reason: string } {
  if (opts.control.variant !== "control") {
    return {
      ok: false,
      reason: `served control variant is "${opts.control.variant}", expected "control"`,
    };
  }
  if (opts.treatment.variant !== "treatment") {
    return {
      ok: false,
      reason: `served treatment variant is "${opts.treatment.variant}", expected "treatment"`,
    };
  }
  if (!opts.control.status.includes(opts.flagName) || !opts.treatment.status.includes(opts.flagName)) {
    return {
      ok: false,
      reason: `flag-status must name ${opts.flagName}`,
    };
  }
  return { ok: true };
}

export function shouldDeleteRecorded(
  feature: { name: string; id: number } | null,
  recorded: RecordedFlag[],
): boolean {
  if (!feature) return false;
  return recorded.some((row) => row.name === feature.name && row.id === feature.id);
}

export async function createFlagViaCliOrApi(
  lift: LiftSelfhost,
  ctx: MutationContext,
  name: string,
  description: string,
  opts: { reuseFlag?: boolean; recorded?: RecordedFlag[] } = {},
) {
  const plan = planOrRefuse(ctx);
  if (plan.ok === false || plan.dryRun) return { ...plan, name, via: "planned", reused: false };
  const existing = await lift.findFeature(name);
  const reuse = canReuseExistingFlag(existing, opts);
  if (reuse.ok === false) return { ...reuse, reused: false };
  if (existing) {
    await lift.ensureTreatmentKey(existing);
    await lift.setTreatmentWeight(name, 0);
    return { ok: true, dryRun: false, via: "admin_api", reused: true, name, id: existing.id };
  }
  const created = await lift.createMultivariateFlag(name, description);
  await lift.setTreatmentWeight(name, 0);
  return { ok: true, dryRun: false, via: "admin_api", reused: false, name, id: created.id };
}

export async function createExperimentViaApi(
  lift: LiftSelfhost,
  ctx: MutationContext,
  opts: { flagName: string; event: string; hypothesis: string; experimentName: string },
) {
  const plan = planOrRefuse(ctx);
  if (plan.ok === false || plan.dryRun) {
    return { ...plan, via: "planned", ...opts };
  }
  const feature = await lift.findFeature(opts.flagName);
  if (!feature) return { ok: false, reason: `flag ${opts.flagName} missing` };
  const existing = (await lift.listExperiments()).filter(
    (row) => experimentFeatureId(row) === feature.id,
  );
  const running = existing.find((row) => experimentIsRunning(row.status ?? ""));
  if (running) {
    return { ok: true, via: "admin_api", resumed: true, experiment: running };
  }
  let metric: { id?: number };
  try {
    metric = (await lift.createMetric(opts.event, `${opts.flagName} completed`)) as { id?: number };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const metricId = metric.id;
  if (!metricId) return { ok: false, reason: "metric id missing" };
  const treatmentId = await lift.treatmentOptionId(opts.flagName);
  if (!treatmentId) return { ok: false, reason: "treatment option id missing" };
  const payload = experimentCreatePayload({
    featureId: feature.id,
    treatmentId,
    metricId,
    name: opts.experimentName,
    hypothesis: opts.hypothesis,
  });
  try {
    const experiment = await lift.createExperiment(payload);
    return { ok: true, via: "admin_api", metricId, experiment };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("unicode") || message.includes("string")) {
      payload.experiment_rollout.feature_state_value.type = "unicode";
      const experiment = await lift.createExperiment(payload);
      return { ok: true, via: "admin_api", metricId, experiment };
    }
    return { ok: false, reason: message };
  }
}

export async function startExperimentViaApi(
  lift: LiftSelfhost,
  ctx: MutationContext,
  experimentId: number,
) {
  const plan = planOrRefuse(ctx);
  if (plan.ok === false || plan.dryRun) return { ...plan, via: "planned", experimentId };
  if (!ctx.gate || ctx.gate.rejected || !ctx.gate.ok) {
    return {
      ok: false,
      reason: "--start requires a passing axe gate on the served control/treatment from this run",
      code: "AXE_GATE",
      experimentId,
      gate: ctx.gate ?? null,
    };
  }
  try {
    const started = await lift.startExperiment(experimentId);
    return { ok: true, via: "admin_api", experiment: started };
  } catch (err) {
    const current = await lift.getExperiment(experimentId);
    if (experimentIsRunning(current.status ?? "")) {
      return { ok: true, via: "admin_api", resumed: true, experiment: current };
    }
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      experimentId,
    };
  }
}

export async function rolloutWinner(
  lift: LiftSelfhost,
  ctx: MutationContext,
  opts: { flagName: string; experimentId?: number; treatmentOptionId?: number },
  hooks: RolloutHooks = {},
): Promise<Record<string, unknown>> {
  const plan = planOrRefuse(ctx);
  if (plan.ok === false) return plan;
  if (plan.dryRun || !ctx.apply) {
    return {
      ok: true,
      waiting: true,
      code: "WAITING_FOR_HUMAN_APPROVAL",
      dryRun: true,
    };
  }
  if (!opts.experimentId) {
    return { ok: false, reason: "approval requires --experiment-id" };
  }
  const target = await assertApprovalTarget(
    lift,
    { flagName: opts.flagName, experimentId: opts.experimentId },
    hooks,
  );
  if (target.ok === false) return target;

  const raw =
    (await hooks.fetchResults?.(opts.experimentId)) ??
    (await lift.getExperimentResults(opts.experimentId));
  const pick = pickRolloutFromResults(raw, CHANCE_TO_WIN_THRESHOLD);
  process.stderr.write(`chance_to_win ${JSON.stringify(pick.chances)}\n`);
  if (!pick.ok || !pick.decision) {
    return { ok: false, step: "results", pick, results: raw };
  }

  const approved = await promptApproveLine(
    opts.experimentId,
    pick.chances,
    hooks.readApprovalLine ?? readTtyLine,
  );
  if (approved.ok === false) return { ok: false, step: "approval", reason: approved.reason, pick };
  process.stderr.write(`approved ${approved.line}\n`);

  const rawAfter =
    (await hooks.fetchResults?.(opts.experimentId)) ??
    (await lift.getExperimentResults(opts.experimentId));
  const pickAfter = pickRolloutFromResults(rawAfter, CHANCE_TO_WIN_THRESHOLD);
  if (pickAfter.winner !== pick.winner) {
    return {
      ok: false,
      step: "approval",
      reason: `winner changed after approval (${pick.winner} -> ${pickAfter.winner})`,
      pick,
      pickAfter,
    };
  }
  if (!pickAfter.ok || !pickAfter.decision) {
    return { ok: false, step: "results", pick: pickAfter, results: rawAfter };
  }

  const treatmentOptionId =
    opts.treatmentOptionId ?? (await lift.treatmentOptionId(opts.flagName));
  if (pickAfter.decision === "rollout_treatment" && !treatmentOptionId) {
    return { ok: false, reason: "treatment option id missing; refusing to pin", pick: pickAfter };
  }
  const body = completeBody(pickAfter.decision, treatmentOptionId ?? 0);

  try {
    if (hooks.complete) await hooks.complete(opts.experimentId, body);
    else await lift.completeExperiment(opts.experimentId, body);
  } catch (err) {
    return {
      ok: false,
      step: "complete",
      pinned: false,
      pick: pickAfter,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const percent = pickAfter.decision === "rollout_treatment" ? 100 : 0;
  const pin =
    (await hooks.pinTreatment?.(opts.flagName, percent)) ??
    (await lift.setTreatmentWeight(opts.flagName, percent));
  if (!hooks.pinTreatment) {
    await lift.assertTreatmentWeight(opts.flagName, percent);
  }
  return { ok: true, dryRun: false, pick: pickAfter, complete: body, pin, approved: approved.line };
}

export async function cleanupStaleFlags(
  lift: LiftSelfhost,
  ctx: MutationContext,
  recorded: RecordedFlag[] = [],
) {
  const plan = planOrRefuse(ctx);
  if (plan.ok === false) return plan;
  const names: string[] = [];
  for (const rec of recorded) {
    if (!rec.name || !Number.isFinite(rec.id)) continue;
    const feature = await lift.findFeature(rec.name);
    if (!shouldDeleteRecorded(feature, recorded)) continue;
    names.push(rec.name);
  }
  if (plan.dryRun) return { ok: true, dryRun: true, names };
  const deleted: string[] = [];
  for (const rec of recorded) {
    if (!names.includes(rec.name)) continue;
    await lift.deleteFeatureById(rec.id);
    deleted.push(rec.name);
  }
  return { ok: true, dryRun: false, deleted };
}

export async function runningExperimentForFeature(
  lift: LiftSelfhost,
  flagName: string,
  hooks: Pick<RolloutHooks, "findFeature"> = {},
): Promise<ExperimentRecord | null> {
  const feature =
    (await hooks.findFeature?.(flagName)) ?? (await lift.findFeature(flagName));
  if (!feature) return null;
  const existing = await lift.listExperiments();
  return (
    existing.find(
      (row) => experimentFeatureId(row) === feature.id && experimentIsRunning(row.status ?? ""),
    ) ?? null
  );
}

export function gateFromSummaries(
  compare: typeof import("./axe-gate.ts").compareAxeGate,
  control: import("./axe-gate.ts").AxeViolationSummary[],
  variant: import("./axe-gate.ts").AxeViolationSummary[],
) {
  return compare(control, variant);
}

export { CHANCE_TO_WIN_THRESHOLD, pickRolloutFromResults };
