import { readFileSync } from "node:fs";
import { Flagsmith } from "@flagsmith/nodejs";
import type { ExperimentDecision, Variant, VisitRecord } from "../../shared/types.ts";
import { eventsPath, loadConfig, readJson, statePath } from "./config.ts";
import {
  FlagsmithAdmin,
  FlagsmithAdminError,
  type ExperimentRecord,
  listResults,
} from "./flagsmith-admin.ts";
import type { BootstrapState } from "./bootstrap.ts";
import { completeBody } from "./payloads.ts";
import {
  armStats,
  bayesianWinProbability,
  decideFromWinProbability,
  relativeLift,
} from "./stats.ts";

export interface FlagsmithResultsPayload {
  srm_p_value?: number | null;
  metrics?: Array<{
    metric_id?: number;
    variants?: Record<
      string,
      { n?: number; sum?: number; sum_squares?: number; mean?: number }
    >;
    inference?: Record<
      string,
      {
        lift?: number;
        ci_low?: number;
        ci_high?: number;
        chance_to_win?: number;
      } | null
    >;
  }>;
}

export interface FlagsmithResultsEnvelope {
  results?: {
    as_of?: string | null;
    payload?: FlagsmithResultsPayload | null;
    last_error_at?: string | null;
    is_final?: boolean;
  } | null;
}

const IDENTITY_FLOOR = 50;
const CONVERSION_FLOOR = 5;
const REFRESH_THROTTLE_MS = 5 * 60 * 1000;

export function loadVisits(path = eventsPath()): VisitRecord[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as VisitRecord);
  } catch {
    return [];
  }
}

export function summariseVisits(visits: VisitRecord[]) {
  const byVariant: Record<Variant, { conversions: number; visitors: number }> = {
    control: { conversions: 0, visitors: 0 },
    treatment: { conversions: 0, visitors: 0 },
  };
  for (const visit of visits) {
    byVariant[visit.variant].visitors += 1;
    if (visit.converted) byVariant[visit.variant].conversions += 1;
  }
  return byVariant;
}

export interface ParsedFlagsmithWin {
  chanceToWin: number;
  lift: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  asOf: string | null;
  flagsmithN: number | null;
  srmPValue: number | null;
  usable: boolean;
  rejectReason?: "error" | "stale" | "srm";
}

export function parseFlagsmithWin(
  envelope: FlagsmithResultsEnvelope | null,
  opts?: {
    treatmentKey?: string;
    localN?: number;
    trafficEndedAt?: string | number | Date;
  },
): ParsedFlagsmithWin | null {
  const payload = envelope?.results?.payload;
  const inference = payload?.metrics?.[0]?.inference;
  if (!inference) return null;
  const treatmentKey = opts?.treatmentKey ?? "treatment";
  const arm =
    inference[treatmentKey] ??
    Object.entries(inference).find(([key]) => key !== "control")?.[1];
  if (!arm || typeof arm.chance_to_win !== "number") return null;

  const variants = payload?.metrics?.[0]?.variants;
  const controlN = variants?.control?.n ?? 0;
  const treatment =
    variants?.treatment ??
    (variants
      ? Object.entries(variants).find(([key]) => key !== "control")?.[1]
      : undefined);
  const flagsmithN =
    variants && (controlN > 0 || (treatment?.n ?? 0) > 0)
      ? controlN + (treatment?.n ?? 0)
      : null;

  const parsed: ParsedFlagsmithWin = {
    chanceToWin: arm.chance_to_win,
    lift: typeof arm.lift === "number" ? arm.lift : null,
    ciLow: typeof arm.ci_low === "number" ? arm.ci_low : null,
    ciHigh: typeof arm.ci_high === "number" ? arm.ci_high : null,
    asOf: envelope?.results?.as_of ?? null,
    flagsmithN,
    srmPValue: typeof payload?.srm_p_value === "number" ? payload.srm_p_value : null,
    usable: true,
  };

  if (envelope?.results?.last_error_at) {
    parsed.usable = false;
    parsed.rejectReason = "error";
    return parsed;
  }
  if (parsed.srmPValue !== null && parsed.srmPValue < 0.01) {
    parsed.usable = false;
    parsed.rejectReason = "srm";
    return parsed;
  }

  const localN = opts?.localN ?? 0;
  const asOfMs = parsed.asOf ? Date.parse(parsed.asOf) : NaN;
  const endedAt = opts?.trafficEndedAt
    ? new Date(opts.trafficEndedAt).getTime()
    : NaN;
  const asOfAfterTraffic = Number.isFinite(asOfMs) && Number.isFinite(endedAt) && asOfMs >= endedAt;
  if (localN > 0 && !asOfAfterTraffic) {
    if (flagsmithN === null || flagsmithN < localN) {
      parsed.usable = false;
      parsed.rejectReason = "stale";
    }
  }
  return parsed;
}

export function floorsMet(
  visits: VisitRecord[],
  envelope?: FlagsmithResultsEnvelope | null,
): boolean {
  const byVariant = summariseVisits(visits);
  const localOk =
    byVariant.control.visitors >= IDENTITY_FLOOR &&
    byVariant.treatment.visitors >= IDENTITY_FLOOR &&
    byVariant.control.conversions >= CONVERSION_FLOOR &&
    byVariant.treatment.conversions >= CONVERSION_FLOOR;
  const metric = envelope?.results?.payload?.metrics?.[0];
  if (metric?.inference && !metric.variants) return false;
  const variants = metric?.variants;
  if (!variants) return localOk;
  const control = variants.control;
  const treatment =
    variants.treatment ??
    Object.entries(variants).find(([key]) => key !== "control")?.[1];
  if (!control || !treatment) return false;
  return (
    (control.n ?? 0) >= IDENTITY_FLOOR &&
    (treatment.n ?? 0) >= IDENTITY_FLOOR &&
    (control.sum ?? 0) >= CONVERSION_FLOOR &&
    (treatment.sum ?? 0) >= CONVERSION_FLOOR
  );
}

export function decideExperiment(input: {
  flag: string;
  visits: VisitRecord[];
  flagsmith?: FlagsmithResultsEnvelope | null;
  threshold: number;
  allowLocalDecision?: boolean;
  statsSeed?: number;
}): ExperimentDecision {
  const byVariant = summariseVisits(input.visits);
  const control = armStats(
    byVariant.control.conversions,
    byVariant.control.visitors,
  );
  const treatment = armStats(
    byVariant.treatment.conversions,
    byVariant.treatment.visitors,
  );
  const notes: string[] = [
    "All traffic is SIMULATED (Playwright persona bots, not humans). Outcomes follow the persona model, not evidence about real users.",
  ];

  const parsed = parseFlagsmithWin(input.flagsmith ?? null, {
    localN: input.visits.length,
  });
  const collecting = !floorsMet(input.visits, input.flagsmith);
  const thresholdPct = `${(input.threshold * 100).toFixed(0)}%`;

  let source: ExperimentDecision["source"] = "local_bayesian";
  let winProbabilityTreatment = bayesianWinProbability(
    treatment,
    control,
    20_000,
    input.statsSeed ?? 20261126,
  );
  let lift: number | null = relativeLift(treatment.rate, control.rate) ?? null;
  let ciLow: number | null = null;
  let ciHigh: number | null = null;

  if (parsed?.usable && !collecting) {
    source = "flagsmith";
    winProbabilityTreatment = parsed.chanceToWin;
    lift = parsed.lift ?? null;
    ciLow = parsed.ciLow;
    ciHigh = parsed.ciHigh;
    notes.push(
      "Win probability from Flagsmith Experimentation (chance_to_win on the results payload).",
    );
    if (parsed.asOf) notes.push(`Flagsmith results as of ${parsed.asOf}.`);
  } else if (parsed?.rejectReason === "srm") {
    source = "flagsmith";
    winProbabilityTreatment = parsed.chanceToWin;
    lift = parsed.lift ?? null;
    ciLow = parsed.ciLow;
    ciHigh = parsed.ciHigh;
    notes.push(
      `Flagsmith srm_p_value=${parsed.srmPValue} is below 0.01; declining to decide (sample-ratio mismatch).`,
    );
  } else if (parsed && !parsed.usable) {
    notes.push(
      parsed.rejectReason === "error"
        ? "Flagsmith results snapshot has last_error_at set; treating it as unusable."
        : "Flagsmith results look stale (n below local visits and as_of not after traffic ended). Using local Beta-Binomial.",
    );
  } else if (parsed && collecting) {
    notes.push(
      "Flagsmith results exist but a variant is still under Lift's 50-identity / 5-conversion-per-arm floor, so Lift uses a local Beta-Binomial win probability.",
    );
  } else {
    notes.push(
      "Flagsmith native results were not available (warehouse still connecting, self-host without events, or refresh pending). Win probability is a local Beta-Binomial Monte Carlo.",
    );
  }

  let decision = decideFromWinProbability(
    winProbabilityTreatment,
    input.threshold,
  );
  if (parsed?.rejectReason === "srm") {
    decision = "keep_running";
  }

  switch (decision) {
    case "rollout_treatment":
      notes.push(`Treatment wins under the ${thresholdPct} chance-to-be-best rule.`);
      break;
    case "pull_to_control":
      notes.push(`Treatment loses under the ${thresholdPct} chance-to-be-best rule.`);
      break;
    case "keep_running":
      notes.push("Inconclusive: leave the experiment running.");
      break;
    default: {
      const _exhaustive: never = decision;
      throw new Error(`Unhandled decision ${_exhaustive}`);
    }
  }

  if (source === "local_bayesian" && decision !== "keep_running") {
    if (input.allowLocalDecision) {
      notes.push(
        "LIFT_ALLOW_LOCAL_DECISION=true: completing the Flagsmith experiment from local math, not chance_to_win. Labelled as local_bayesian everywhere.",
      );
    } else {
      notes.push(
        "Not completing the Flagsmith experiment: source is local_bayesian. Poll results until chance_to_win exists, or set LIFT_ALLOW_LOCAL_DECISION=true.",
      );
    }
  }

  return {
    flag: input.flag,
    decision,
    source,
    winProbabilityTreatment,
    lift,
    ciLow,
    ciHigh,
    control,
    treatment,
    threshold: input.threshold,
    notes,
  };
}

export function shouldApplyDecision(
  decision: ExperimentDecision,
  allowLocalDecision: boolean,
): boolean {
  if (decision.decision === "keep_running") return false;
  if (decision.source === "flagsmith") return true;
  return allowLocalDecision;
}

export async function fetchFlagsmithResults(
  experimentId: number,
  opts?: { refresh?: boolean },
): Promise<FlagsmithResultsEnvelope | null> {
  const cfg = loadConfig();
  if (!cfg.adminToken || !cfg.environmentKey) return null;
  const admin = new FlagsmithAdmin(cfg);
  if (opts?.refresh !== false) {
    try {
      await admin.post(
        `/environments/${cfg.environmentKey}/experiments/${experimentId}/results/refresh/`,
      );
    } catch (err) {
      if (err instanceof FlagsmithAdminError) {
        process.stderr.write(
          `results/refresh ${err.status}: ${err.body.slice(0, 240)}\n`,
        );
      } else {
        process.stderr.write(`results/refresh error: ${err}\n`);
      }
    }
  }
  const { data } = await admin.get<FlagsmithResultsEnvelope>(
    `/environments/${cfg.environmentKey}/experiments/${experimentId}/results/`,
  );
  return data;
}

export async function waitForFlagsmithResults(input: {
  experimentId: number;
  visits: VisitRecord[];
  waitMs: number;
  trafficEndedAt?: string | number | Date;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<FlagsmithResultsEnvelope | null> {
  const sleep = input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = input.now ?? Date.now;
  const deadline = now() + input.waitMs;
  let lastRefresh = 0;
  let delay = 10_000;
  let latest: FlagsmithResultsEnvelope | null = null;

  while (true) {
    const t = now();
    const refresh = lastRefresh === 0 || t - lastRefresh >= REFRESH_THROTTLE_MS;
    latest = await fetchFlagsmithResults(input.experimentId, { refresh });
    if (refresh) lastRefresh = t;
    const parsed = parseFlagsmithWin(latest, {
      localN: input.visits.length,
      trafficEndedAt: input.trafficEndedAt,
    });
    if (parsed?.usable && floorsMet(input.visits, latest)) return latest;
    if (t >= deadline) return latest;
    const wait = Math.min(delay, Math.max(0, deadline - t));
    if (wait <= 0) return latest;
    await sleep(wait);
    delay = Math.min(Math.floor(delay * 1.5), 60_000);
  }
}

export interface FeatureStateRecord {
  id: number;
  enabled?: boolean;
  feature_state_value?: unknown;
  multivariate_feature_state_values?: Array<{
    id?: number;
    multivariate_feature_option: number | { id: number };
    percentage_allocation: number;
  }>;
}

export async function setEnvironmentDefault(
  admin: FlagsmithAdmin,
  envKey: string,
  flagId: number,
  treatmentOptionId: number,
  variant: Variant,
): Promise<void> {
  const { data } = await admin.get<unknown>(
    `/environments/${envKey}/featurestates/?feature=${flagId}`,
  );
  const states = listResults<FeatureStateRecord>(data);
  const state = states[0];
  if (!state) {
    throw new Error(`No environment feature state for feature ${flagId}`);
  }
  const allocation = variant === "treatment" ? 100 : 0;
  const mv = (state.multivariate_feature_state_values ?? []).map((row) => {
    const optionId =
      typeof row.multivariate_feature_option === "number"
        ? row.multivariate_feature_option
        : row.multivariate_feature_option.id;
    return {
      id: row.id,
      multivariate_feature_option: optionId,
      percentage_allocation: optionId === treatmentOptionId ? allocation : 0,
    };
  });
  await admin.patch(`/features/featurestates/${state.id}/`, {
    enabled: true,
    feature_state_value: variant === "treatment" ? "treatment" : "control",
    multivariate_feature_state_values: mv,
  });
}

export async function evaluateIdentityVariant(
  flagName: string,
  identity: string,
): Promise<{ variant: string | undefined; value: unknown }> {
  const cfg = loadConfig();
  const key = cfg.serverKey || cfg.environmentKey;
  if (!key) throw new Error("FLAGSMITH_SERVER_KEY or FLAGSMITH_ENVIRONMENT_KEY required to verify rollout");
  const flagsmith = new Flagsmith({
    environmentKey: key,
    apiUrl: cfg.adminApiUrl || cfg.apiUrl,
    enableLocalEvaluation: Boolean(cfg.serverKey),
  });
  try {
    const flags = await flagsmith.getIdentityFlags(identity, {
      simulated: true,
      purpose: "rollout_verify",
    });
    const flag = flags.getFlag(flagName);
    const variant =
      "variant" in flag && typeof flag.variant === "string" ? flag.variant : undefined;
    return { variant, value: flag.value };
  } finally {
    await flagsmith.close(2000);
  }
}

export function variantMatches(
  got: { variant?: string; value?: unknown },
  expected: Variant,
): boolean {
  return got.variant === expected && got.value === expected;
}

export async function applyDecision(
  decision: ExperimentDecision,
  deps?: {
    evaluateIdentity?: typeof evaluateIdentityVariant;
    setDefault?: typeof setEnvironmentDefault;
    allowLocalDecision?: boolean;
  },
): Promise<void> {
  const cfg = loadConfig();
  const state = readJson<BootstrapState>(statePath());
  if (!state || !cfg.adminToken || !cfg.environmentKey) {
    throw new Error("Bootstrap state and Flagsmith admin credentials are required to roll out");
  }
  if (decision.decision === "keep_running") return;
  const allowLocal = deps?.allowLocalDecision ?? cfg.allowLocalDecision;
  if (decision.source !== "flagsmith" && !allowLocal) {
    process.stderr.write(
      "Not completing: source is local_bayesian. Set LIFT_ALLOW_LOCAL_DECISION=true to apply local math.\n",
    );
    return;
  }

  const admin = new FlagsmithAdmin(cfg);
  const { data: experiment } = await admin.get<ExperimentRecord>(
    `/environments/${cfg.environmentKey}/experiments/${state.experimentId}/`,
  );
  if (experiment.status !== "running") {
    throw new Error(
      `Refusing to complete experiment ${state.experimentId}: status is ${experiment.status}, expected running`,
    );
  }

  const body = completeBody(decision.decision, state.treatmentOptionId);
  await admin.post(
    `/environments/${cfg.environmentKey}/experiments/${state.experimentId}/complete/`,
    body,
  );

  const { data: completed } = await admin.get<ExperimentRecord>(
    `/environments/${cfg.environmentKey}/experiments/${state.experimentId}/`,
  );
  if (completed.status !== "completed") {
    throw new Error(
      `complete/ did not mark experiment ${state.experimentId} completed (status=${completed.status})`,
    );
  }
  if (completed.rollout_decision !== body.rollout_decision) {
    throw new Error(
      `complete/ did not stick: rollout_decision=${completed.rollout_decision} expected ${body.rollout_decision}`,
    );
  }
  if (
    body.rollout_decision === "variant" &&
    completed.rollout_variant !== state.treatmentOptionId &&
    Number(completed.rollout_variant) !== state.treatmentOptionId
  ) {
    throw new Error(
      `complete/ rollout_variant=${completed.rollout_variant} expected ${state.treatmentOptionId}`,
    );
  }

  const expected: Variant =
    decision.decision === "rollout_treatment" ? "treatment" : "control";
  const evaluate = deps?.evaluateIdentity ?? evaluateIdentityVariant;
  let got = await evaluate(state.flagName, `lift-verify-${Date.now()}`);
  if (variantMatches(got, expected)) return;

  process.stderr.write(
    `Fresh identity evaluated to variant=${got.variant} value=${String(got.value)}, expected ${expected}. Falling back to environment default PATCH.\n`,
  );
  const setDefault = deps?.setDefault ?? setEnvironmentDefault;
  await setDefault(
    admin,
    cfg.environmentKey,
    state.flagId,
    state.treatmentOptionId,
    expected,
  );
  got = await evaluate(state.flagName, `lift-verify-fallback-${Date.now()}`);
  if (!variantMatches(got, expected)) {
    throw new Error(
      `Environment default fallback failed: identity still sees variant=${got.variant} value=${String(got.value)}, expected ${expected}`,
    );
  }
}

async function main() {
  const cfg = loadConfig();
  const state = readJson<BootstrapState>(statePath());
  const visits = loadVisits();
  const flagsmith = state
    ? await waitForFlagsmithResults({
        experimentId: state.experimentId,
        visits,
        waitMs: cfg.resultsWaitMs,
      })
    : null;
  const decision = decideExperiment({
    flag: cfg.flagName,
    visits,
    flagsmith,
    threshold: cfg.winThreshold,
    allowLocalDecision: cfg.allowLocalDecision,
    statsSeed: cfg.trafficSeed,
  });
  await applyDecision(decision);
  process.stdout.write(`${JSON.stringify({ decision, flagsmith }, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : err}\n`);
    process.exit(1);
  });
}
