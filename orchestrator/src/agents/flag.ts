import type { EventLog } from "../log.ts";
import type { FlagSetup, FlagVariantRecord, GateResult, OrchOptions } from "../types.ts";
import { FlagsmithHttp, FlagsmithHttpError, listResults } from "../flagsmith/http.ts";
import { flagsmithEnv, tryCliJson, type RunCli, runFlagsmithCli } from "../flagsmith/cli.ts";

export interface FeatureRecord {
  id: number;
  name: string;
  type?: string;
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
  if (found) return found;
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

async function ensureExperiment(
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
    const featureId = typeof exp.feature === "number" ? exp.feature : exp.feature?.id;
    return featureId === flag.id && exp.status !== "completed";
  });
  if (existing) return existing;

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

async function startExperiment(
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
      "Lift orchestrator gated accessibility variants",
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

export async function runFlagAgent(
  opts: OrchOptions,
  passed: GateResult[],
  generation: number,
  controlKey: string,
  log: EventLog,
  deps?: { http?: FlagsmithHttp; runCli?: RunCli },
): Promise<FlagSetup> {
  const flagName = generation === 1 ? opts.flagName : `${opts.flagName}_g${generation}`;
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
      "Lift orchestrator gated accessibility variants. Payloads are axe-gated spec ids.",
      controlKey,
    ));

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
  const experiment = await ensureExperiment(
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
  const dashboardUrl = `${opts.dashboardUrl}/project/${opts.projectId}/environment/${opts.environmentId || opts.environmentKey}/experiments/${running.id}`;
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
  });
  return setup;
}
