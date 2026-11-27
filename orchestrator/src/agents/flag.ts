import type { EventLog } from "../log.ts";
import {
  DESCRIPTION_MARKER,
  FLAG_PREFIX,
  assertOrchFlagName,
  assertSpecId,
  genFlagName,
  isOrchDescription,
} from "../names.ts";
import type { FlagSetup, FlagVariantRecord, GateResult, OrchOptions } from "../types.ts";
import { FlagsmithHttp, FlagsmithHttpError, listResults } from "../flagsmith/http.ts";
import { flagsmithEnv, tryCliJson, type RunCli, runFlagsmithCli } from "../flagsmith/cli.ts";

export interface FeatureRecord {
  id: number;
  name: string;
  type?: string;
  description?: string | null;
  multivariate_options?: Array<{
    id: number;
    string_value?: string | null;
    key?: string | null;
    default_percentage_allocation?: number;
  }>;
}

export interface MetricRecord {
  id: number;
  name: string;
  definition?: { event?: string };
}

export interface ExperimentRecord {
  id: number;
  name: string;
  status: string;
  feature?: number | { id: number };
}

function equalWeights(variantCount: number): number {
  return Math.floor(100 / (variantCount + 1));
}

function featureIdOf(exp: ExperimentRecord): number | undefined {
  return typeof exp.feature === "number" ? exp.feature : exp.feature?.id;
}

function orchDescription(): string {
  return `${DESCRIPTION_MARKER}. Payloads are axe-gated spec ids.`;
}

function dashboardExperimentUrl(opts: OrchOptions, experimentId: number): string {
  const envSlug = opts.environmentKey || opts.environmentId || opts.projectId;
  return `${opts.dashboardUrl}/project/${opts.projectId}/environment/${envSlug}/experiments/${experimentId}`;
}

async function createFeatureHttp(
  http: FlagsmithHttp,
  projectId: string,
  name: string,
  description: string,
  controlValue: string,
): Promise<FeatureRecord> {
  const { data: existing } = await http.get<unknown>(
    `/projects/${projectId}/features/?search=${encodeURIComponent(name)}`,
  );
  const found = listResults<FeatureRecord>(existing).find((item) => item.name === name);
  if (found) {
    const { data: full } = await http.get<FeatureRecord>(`/projects/${projectId}/features/${found.id}/`);
    if (!isOrchDescription(full.description ?? found.description)) {
      throw new Error(
        `Refusing foreign flag ${name}. Orchestrator only manages ${FLAG_PREFIX}* flags marked "${DESCRIPTION_MARKER}".`,
      );
    }
    throw new Error(
      `Stale flag ${name} already exists (id=${found.id}). Use a unique --flag-name or --cleanup.`,
    );
  }
  const created = await http.post<FeatureRecord>(`/projects/${projectId}/features/`, {
    name,
    default_enabled: true,
    initial_value: controlValue,
    description,
    type: "MULTIVARIATE",
    multivariate_options: [],
  });
  return created.data;
}

async function addVariantHttp(
  http: FlagsmithHttp,
  projectId: string,
  feature: FeatureRecord,
  key: string,
): Promise<{ id: number; key: string }> {
  assertSpecId(key);
  const { data } = await http.get<unknown>(`/projects/${projectId}/features/${feature.id}/mv-options/`);
  const options = listResults<{ id: number; string_value?: string | null; key?: string | null }>(data);
  const existing = options.find((item) => item.key === key || item.string_value === key);
  if (existing) return { id: existing.id, key };
  const created = await http.post<{ id: number; key?: string }>(
    `/projects/${projectId}/features/${feature.id}/mv-options/`,
    {
      type: "unicode",
      string_value: key,
      default_percentage_allocation: 0,
      key,
      feature: feature.id,
    },
  );
  return { id: created.data.id, key };
}

async function ensureMetric(
  http: FlagsmithHttp,
  envKey: string,
  event: string,
): Promise<MetricRecord> {
  const { data } = await http.get<unknown>(`/environments/${envKey}/experiment-metrics/`);
  const existing = listResults<MetricRecord>(data).find((item) => item.definition?.event === event);
  if (existing) return existing;
  const created = await http.post<MetricRecord>(`/environments/${envKey}/experiment-metrics/`, {
    name: "Checkout completed",
    description: "Visitor submitted a completed checkout. Simulated traffic is labelled in identity traits.",
    aggregation: "occurrence",
    direction: "up",
    definition: { version: 1, event },
  });
  return created.data;
}

async function createExperiment(
  http: FlagsmithHttp,
  envKey: string,
  flag: FeatureRecord,
  variants: FlagVariantRecord[],
  metricId: number,
  name: string,
  hypothesis: string,
  controlValue: string,
): Promise<ExperimentRecord> {
  const { data } = await http.get<unknown>(`/environments/${envKey}/experiments/?q=${encodeURIComponent(flag.name)}`);
  const existing = listResults<ExperimentRecord>(data).find((exp) => {
    return featureIdOf(exp) === flag.id && exp.status !== "completed" && exp.status !== "paused";
  });
  if (existing) {
    throw new Error(
      `Stale experiment ${existing.id} still ${existing.status} on ${flag.name}. Pass --cleanup or a unique --flag-name.`,
    );
  }

  const weight = equalWeights(variants.length);
  const payload = {
    feature: flag.id,
    name,
    hypothesis,
    metrics: [{ metric: metricId, expected_direction: "increase" }],
    experiment_rollout: {
      enabled: true,
      rollout_percentage: 100,
      feature_state_value: { type: "string" as const, value: controlValue },
      multivariate_feature_state_values: variants.map((variant) => ({
        multivariate_feature_option: variant.optionId,
        percentage_allocation: weight,
      })),
    },
  };
  try {
    const created = await http.post<ExperimentRecord>(`/environments/${envKey}/experiments/`, payload);
    return created.data;
  } catch (err) {
    if (err instanceof FlagsmithHttpError && (err.body.includes("unicode") || err.body.includes("string"))) {
      payload.experiment_rollout.feature_state_value = {
        type: "unicode" as unknown as "string",
        value: controlValue,
      };
      const created = await http.post<ExperimentRecord>(`/environments/${envKey}/experiments/`, payload);
      return created.data;
    }
    throw err;
  }
}

export async function startExperiment(
  http: FlagsmithHttp,
  envKey: string,
  experiment: ExperimentRecord,
): Promise<ExperimentRecord> {
  if (experiment.status === "running") return experiment;
  const started = await http.post<ExperimentRecord>(
    `/environments/${envKey}/experiments/${experiment.id}/start/`,
  );
  return started.data;
}

export async function pauseExperiment(
  http: FlagsmithHttp,
  envKey: string,
  experimentId: number,
  log: EventLog,
): Promise<void> {
  await http.post(`/environments/${envKey}/experiments/${experimentId}/pause/`);
  log.emit("flag", "info", `Paused experiment ${experimentId}`);
}

async function createViaCli(
  run: RunCli,
  opts: OrchOptions,
  flagName: string,
  controlValue: string,
  variantKeys: string[],
  log: EventLog,
): Promise<{ usedCli: boolean; feature?: FeatureRecord }> {
  if (!opts.adminToken || !opts.projectId || !opts.environmentKey) {
    return { usedCli: false };
  }
  const env = flagsmithEnv({
    apiUrl: opts.adminApiUrl || opts.apiUrl,
    token: opts.adminToken,
    projectId: opts.projectId,
    environmentKey: opts.environmentKey,
  });
  const created = await tryCliJson<FeatureRecord>(
    run,
    [
      "feature",
      "create",
      flagName,
      "--value",
      controlValue,
      "--enabled",
      "--description",
      orchDescription(),
      "-p",
      opts.projectId,
      "-e",
      opts.environmentKey,
    ],
    env,
  );
  if (!created.ok) {
    log.emit("flag", "warn", `CLI feature create unavailable; using Admin API (${created.error.slice(0, 160)})`);
    return { usedCli: false };
  }
  for (const key of variantKeys) {
    const added = await tryCliJson(
      run,
      [
        "feature",
        "variant",
        "add",
        flagName,
        "--value",
        key,
        "--key",
        key,
        "--weight",
        "0",
        "-p",
        opts.projectId,
        "-e",
        opts.environmentKey,
      ],
      env,
    );
    if (!added.ok) {
      log.emit("flag", "warn", `CLI variant add failed for ${key}; Admin API will fill in`);
    }
  }
  log.emit("flag", "info", `CLI created feature ${flagName} with ${variantKeys.length} keyed variants`);
  return { usedCli: true, feature: created.data };
}

export async function loadFlagSetupFromExperiment(
  opts: OrchOptions,
  experimentId: number,
  http: FlagsmithHttp,
): Promise<FlagSetup> {
  if (!opts.environmentKey || !opts.projectId) {
    throw new Error("FLAGSMITH_ENVIRONMENT_KEY and FLAGSMITH_PROJECT_ID are required to approve");
  }
  const { data: experiment } = await http.get<ExperimentRecord>(
    `/environments/${opts.environmentKey}/experiments/${experimentId}/`,
  );
  const featureId = featureIdOf(experiment);
  if (!featureId) {
    throw new Error(`Experiment ${experimentId} has no feature`);
  }
  const { data: feature } = await http.get<FeatureRecord>(`/projects/${opts.projectId}/features/${featureId}/`);
  if (!feature.name.startsWith(FLAG_PREFIX) || !isOrchDescription(feature.description)) {
    throw new Error(`Experiment ${experimentId} is not an orchestrator flag`);
  }
  const { data: optionPayload } = await http.get<unknown>(
    `/projects/${opts.projectId}/features/${feature.id}/mv-options/`,
  );
  const options = listResults<{ id: number; string_value?: string | null; key?: string | null }>(optionPayload);
  const variants: FlagVariantRecord[] = options.map((option) => {
    const key = option.key || option.string_value || "";
    return { key, specId: key, optionId: option.id, title: key };
  });
  return {
    dryRun: false,
    flagName: feature.name,
    flagId: feature.id,
    metricId: 0,
    metricEvent: opts.metricEvent,
    experimentId: experiment.id,
    experimentName: experiment.name,
    variants,
    controlKey: "control",
    dashboardUrl: dashboardExperimentUrl(opts, experiment.id),
    usedCli: false,
  };
}

export async function cleanupOrchFlags(
  opts: OrchOptions,
  log: EventLog,
  http?: FlagsmithHttp,
): Promise<string[]> {
  if (!opts.adminToken || !opts.projectId || !opts.environmentKey) {
    throw new Error("FLAGSMITH_ADMIN_API_TOKEN, FLAGSMITH_PROJECT_ID, and FLAGSMITH_ENVIRONMENT_KEY are required for --cleanup");
  }
  const client =
    http ??
    new FlagsmithHttp({
      baseUrl: opts.adminApiUrl || opts.apiUrl,
      token: opts.adminToken,
    });
  const { data } = await client.get<unknown>(`/projects/${opts.projectId}/features/`);
  const features = listResults<FeatureRecord>(data).filter((item) => item.name.startsWith(FLAG_PREFIX));
  const removed: string[] = [];
  for (const feature of features) {
    const { data: full } = await client.get<FeatureRecord>(`/projects/${opts.projectId}/features/${feature.id}/`);
    if (!isOrchDescription(full.description ?? feature.description)) {
      log.emit("flag", "warn", `Skipping ${feature.name} (no orch description marker)`);
      continue;
    }
    try {
      const { data: experiments } = await client.get<unknown>(
        `/environments/${opts.environmentKey}/experiments/?q=${encodeURIComponent(feature.name)}`,
      );
      for (const exp of listResults<ExperimentRecord>(experiments)) {
        if (featureIdOf(exp) !== feature.id) continue;
        if (exp.status === "running") {
          try {
            await pauseExperiment(client, opts.environmentKey, exp.id, log);
          } catch {
            log.emit("flag", "warn", `Could not pause experiment ${exp.id} before cleanup`);
          }
        }
      }
    } catch {
      log.emit("flag", "warn", `Could not list experiments for ${feature.name}`);
    }
    await client.delete(`/projects/${opts.projectId}/features/${feature.id}/`);
    removed.push(feature.name);
    log.emit("flag", "info", `Deleted ${feature.name}`);
  }
  return removed;
}

export async function runFlagAgent(
  opts: OrchOptions,
  passed: GateResult[],
  generation: number,
  controlKey: string,
  log: EventLog,
  deps?: { http?: FlagsmithHttp; runCli?: RunCli },
): Promise<FlagSetup> {
  const flagName = genFlagName(opts.flagName, generation);
  assertOrchFlagName(flagName);
  for (const item of passed) assertSpecId(item.specId);
  const variantsPreview = passed.map((item) => item.specId);
  log.emit("flag", "start", `Multivariate flag ${flagName} variants=${variantsPreview.join(",") || "(none)"}`);

  if (!opts.apply) {
    const dry: FlagSetup = {
      dryRun: true,
      flagName,
      flagId: 0,
      metricId: 0,
      metricEvent: opts.metricEvent,
      experimentId: 0,
      experimentName: `${flagName} (dry-run)`,
      variants: passed.map((item, index) => ({
        key: item.specId,
        specId: item.specId,
        optionId: index + 1,
        title: item.title,
      })),
      controlKey,
      dashboardUrl: opts.dashboardUrl,
      usedCli: false,
    };
    log.emit("flag", "info", "Dry-run: not mutating Flagsmith. Pass --apply to create the flag, metric, and experiment.");
    log.emit("flag", "done", `Would create ${flagName} + metric ${opts.metricEvent} + experiment`);
    return dry;
  }

  if (!opts.adminToken || !opts.projectId || !opts.environmentKey) {
    throw new Error("FLAGSMITH_ADMIN_API_TOKEN, FLAGSMITH_PROJECT_ID, and FLAGSMITH_ENVIRONMENT_KEY are required for --apply");
  }

  const http =
    deps?.http ??
    new FlagsmithHttp({
      baseUrl: opts.adminApiUrl || opts.apiUrl,
      token: opts.adminToken,
    });
  const runCli = deps?.runCli ?? runFlagsmithCli;
  const cli = await createViaCli(
    runCli,
    opts,
    flagName,
    controlKey,
    passed.map((item) => item.specId),
    log,
  );

  const feature =
    cli.feature ??
    (await createFeatureHttp(
      http,
      opts.projectId,
      flagName,
      orchDescription(),
      controlKey,
    ));

  if (!isOrchDescription(feature.description) && !cli.usedCli) {
    throw new Error(`Refusing foreign flag ${feature.name}`);
  }

  const variants: FlagVariantRecord[] = [];
  for (const item of passed) {
    const option = await addVariantHttp(http, opts.projectId, feature, item.specId);
    variants.push({
      key: item.specId,
      specId: item.specId,
      optionId: option.id,
      title: item.title,
    });
  }

  const metric = await ensureMetric(http, opts.environmentKey, opts.metricEvent);
  const experimentName = `Lift orch g${generation} ${flagName}`;
  const experiment = await createExperiment(
    http,
    opts.environmentKey,
    feature,
    variants,
    metric.id,
    experimentName,
    "Axe-gated accessibility patch specs compete on checkout_completed. Traffic is simulated.",
    controlKey,
  );
  const running = await startExperiment(http, opts.environmentKey, experiment);
  const dashboardUrl = dashboardExperimentUrl(opts, running.id);
  const setup: FlagSetup = {
    dryRun: false,
    flagName: feature.name,
    flagId: feature.id,
    metricId: metric.id,
    metricEvent: opts.metricEvent,
    experimentId: running.id,
    experimentName,
    variants,
    controlKey,
    dashboardUrl,
    usedCli: cli.usedCli,
  };
  log.emit("flag", "done", `flag id=${setup.flagId} metric id=${setup.metricId} experiment id=${setup.experimentId}`, {
    flagId: setup.flagId,
    metricId: setup.metricId,
    experimentId: setup.experimentId,
    usedCli: setup.usedCli,
    dashboardUrl: setup.dashboardUrl,
  });
  return setup;
}
