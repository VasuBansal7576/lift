import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import barriersCatalog from "../../shared/barriers.json" with { type: "json" };
import type { Barrier } from "../../shared/types.ts";
import {
  type LiftConfig,
  ROOT,
  loadConfig,
  statePath,
} from "./config.ts";
import {
  FlagsmithAdmin,
  FlagsmithAdminError,
  type EnvironmentRecord,
  type ExperimentRecord,
  type FeatureOption,
  type FeatureRecord,
  type MetricRecord,
  type WarehouseRecord,
  listResults,
} from "./flagsmith-admin.ts";

export interface BootstrapState {
  organisationId: number | string;
  projectId: number | string;
  environmentId: number | string;
  environmentKey: string;
  serverKey?: string;
  flagName: string;
  flagId: number;
  treatmentOptionId: number;
  metricId: number;
  experimentId: number;
  warehouseId?: number;
  barrierFlags: { name: string; id: number }[];
  createdAt: string;
}

async function findFeature(
  admin: FlagsmithAdmin,
  projectId: string,
  name: string,
): Promise<FeatureRecord | null> {
  const { data } = await admin.get<unknown>(
    `/projects/${projectId}/features/?search=${encodeURIComponent(name)}`,
  );
  return listResults<FeatureRecord>(data).find((f) => f.name === name) ?? null;
}

async function ensureFeature(
  admin: FlagsmithAdmin,
  projectId: string,
  name: string,
  description: string,
  treatmentAllocation: number,
): Promise<FeatureRecord> {
  const existing = await findFeature(admin, projectId, name);
  if (existing) return existing;

  const { data } = await admin.post<FeatureRecord>(
    `/projects/${projectId}/features/`,
    {
      name,
      default_enabled: true,
      initial_value: "control",
      description,
      type: "MULTIVARIATE",
      multivariate_options: [
        {
          type: "unicode",
          string_value: "treatment",
          default_percentage_allocation: treatmentAllocation,
        },
      ],
    },
  );
  return data;
}

async function ensureTreatmentKey(
  admin: FlagsmithAdmin,
  projectId: string,
  feature: FeatureRecord,
): Promise<FeatureOption> {
  const { data } = await admin.get<unknown>(
    `/projects/${projectId}/features/${feature.id}/mv-options/`,
  );
  const options = listResults<FeatureOption>(data);
  const treatment =
    options.find((o) => o.string_value === "treatment") ?? options[0];
  if (!treatment) {
    throw new Error(`Feature ${feature.name} has no multivariate option`);
  }
  if (treatment.key !== "treatment") {
    try {
      await admin.patch(
        `/projects/${projectId}/features/${feature.id}/mv-options/${treatment.id}/`,
        { key: "treatment" },
      );
      treatment.key = "treatment";
    } catch (err) {
      if (!(err instanceof FlagsmithAdminError && err.status === 400)) {
        throw err;
      }
    }
  }
  return treatment;
}

async function tryCreateWarehouse(
  admin: FlagsmithAdmin,
  envKey: string,
  body: Record<string, unknown>,
): Promise<WarehouseRecord | null> {
  try {
    const created = await admin.post<WarehouseRecord>(
      `/environments/${envKey}/warehouse-connections/`,
      body,
    );
    return created.data;
  } catch (err) {
    if (err instanceof FlagsmithAdminError) {
      process.stderr.write(
        `Warehouse ${JSON.stringify(body.warehouse_type)} not created (${err.status}): ${err.body.slice(0, 240)}\n`,
      );
      return null;
    }
    throw err;
  }
}

async function ensureWarehouse(
  admin: FlagsmithAdmin,
  envKey: string,
  apiUrl: string,
): Promise<WarehouseRecord> {
  const { data } = await admin.get<unknown>(
    `/environments/${envKey}/warehouse-connections/`,
  );
  const existing = Array.isArray(data)
    ? (data as WarehouseRecord[])
    : listResults<WarehouseRecord>(data);
  if (existing[0]) return existing[0];

  const cloud = /flagsmith\.com/i.test(apiUrl);
  const attempts: Record<string, unknown>[] = cloud
    ? [
        { warehouse_type: "flagsmith", name: "Lift Flagsmith warehouse" },
        {
          warehouse_type: "postgres",
          name: "Lift Flagsmith database",
          config: { source: "flagsmith_database" },
        },
      ]
    : [
        {
          warehouse_type: "postgres",
          name: "Lift Flagsmith database",
          config: { source: "flagsmith_database" },
        },
        { warehouse_type: "flagsmith", name: "Lift Flagsmith warehouse" },
      ];

  for (const body of attempts) {
    const created = await tryCreateWarehouse(admin, envKey, body);
    if (created) return created;
  }

  throw new Error(
    "No warehouse connection. Experiments cannot be created without one. Cloud: Environment Settings → Warehouse → enable Flagsmith. Self-host: enable Flagsmith database (warehouse_type postgres, config.source flagsmith_database). See https://docs.flagsmith.com/experimentation/connect-a-warehouse",
  );
}

async function ensureMetric(
  admin: FlagsmithAdmin,
  envKey: string,
  event: string,
): Promise<MetricRecord> {
  const { data } = await admin.get<unknown>(
    `/environments/${envKey}/experiment-metrics/`,
  );
  const existing = listResults<MetricRecord>(data).find(
    (m) => m.definition?.event === event || m.name === "Checkout completed",
  );
  if (existing) return existing;
  const created = await admin.post<MetricRecord>(
    `/environments/${envKey}/experiment-metrics/`,
    {
      name: "Checkout completed",
      description: "Visitor submitted a completed checkout. Simulated traffic is labelled in identity traits.",
      aggregation: "occurrence",
      direction: "up",
      definition: { version: 1, event },
    },
  );
  return created.data;
}

async function ensureExperiment(
  admin: FlagsmithAdmin,
  envKey: string,
  flag: FeatureRecord,
  treatmentId: number,
  metricId: number,
): Promise<ExperimentRecord> {
  const { data } = await admin.get<unknown>(
    `/environments/${envKey}/experiments/?q=${encodeURIComponent(flag.name)}`,
  );
  const existing = listResults<ExperimentRecord>(data).find((exp) => {
    const featureId = typeof exp.feature === "number" ? exp.feature : exp.feature?.id;
    return featureId === flag.id && exp.status !== "completed";
  });
  if (existing) return existing;

  const payload = {
    feature: flag.id,
    name: "Checkout accessibility lift",
    hypothesis:
      "Fixing WCAG barriers (hover-only menu, unlabeled icon, non-focusable Place order, missing labels, low-contrast terms) increases checkout completion for keyboard, screen-reader, and low-vision visitors.",
    metrics: [{ metric: metricId, expected_direction: "increase" }],
    experiment_rollout: {
      enabled: true,
      rollout_percentage: 100,
      feature_state_value: { type: "string", value: "control" },
      multivariate_feature_state_values: [
        {
          multivariate_feature_option: treatmentId,
          percentage_allocation: 50,
        },
      ],
    },
  };

  try {
    const created = await admin.post<ExperimentRecord>(
      `/environments/${envKey}/experiments/`,
      payload,
    );
    return created.data;
  } catch (err) {
    if (
      err instanceof FlagsmithAdminError &&
      (err.body.includes("unicode") || err.body.includes("string"))
    ) {
      payload.experiment_rollout.feature_state_value.type = "unicode";
      const created = await admin.post<ExperimentRecord>(
        `/environments/${envKey}/experiments/`,
        payload,
      );
      return created.data;
    }
    throw err;
  }
}

async function startExperiment(
  admin: FlagsmithAdmin,
  envKey: string,
  experiment: ExperimentRecord,
): Promise<ExperimentRecord> {
  if (experiment.status === "running") return experiment;
  const started = await admin.post<ExperimentRecord>(
    `/environments/${envKey}/experiments/${experiment.id}/start/`,
  );
  return started.data;
}

function writeCheckoutConfig(cfg: LiftConfig) {
  const config = {
    flagsmithApiUrl: cfg.apiUrl,
    flagsmithEventsUrl: cfg.eventsUrl,
    flagsmithEnvironmentKey: cfg.environmentKey,
    flagName: cfg.flagName,
    metricEvent: cfg.metricEvent,
    allowMock: cfg.allowMock,
    simulatedTrafficLabel: "SIMULATED TRAFFIC",
  };
  writeFileSync(
    resolve(ROOT, "sites/checkout/config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

export async function bootstrap(cfg = loadConfig()): Promise<BootstrapState> {
  if (!cfg.adminToken) {
    throw new Error(
      "FLAGSMITH_ADMIN_API_TOKEN is required. Create one in Organisation Settings > API Access.",
    );
  }
  if (!cfg.projectId || !cfg.environmentKey) {
    throw new Error(
      "FLAGSMITH_PROJECT_ID and FLAGSMITH_ENVIRONMENT_KEY are required (cloud Lift project is 56470).",
    );
  }

  const admin = new FlagsmithAdmin(cfg);
  const envKey = cfg.environmentKey;

  let environmentId = cfg.environmentId;
  if (!environmentId) {
    const { data } = await admin.get<unknown>(
      `/projects/${cfg.projectId}/environments/`,
    );
    const envs = listResults<EnvironmentRecord>(data);
    const match =
      envs.find((e) => e.api_key === envKey) ??
      envs.find((e) => e.name === cfg.environmentName) ??
      envs[0];
    if (!match) throw new Error("No Flagsmith environment found");
    environmentId = String(match.id);
  }

  const warehouse = await ensureWarehouse(admin, envKey, cfg.apiUrl);

  const combined = await ensureFeature(
    admin,
    cfg.projectId,
    cfg.flagName,
    "Combined accessibility treatment for Northline checkout. control = baked-in WCAG barriers, treatment = Kane-style fixes.",
    50,
  );
  const treatment = await ensureTreatmentKey(admin, cfg.projectId, combined);

  const barrierFlags: { name: string; id: number }[] = [];
  for (const barrier of barriersCatalog as Barrier[]) {
    const feature = await ensureFeature(
      admin,
      cfg.projectId,
      barrier.flag,
      `${barrier.title}. ${barrier.control} / ${barrier.treatment}`,
      0,
    );
    await ensureTreatmentKey(admin, cfg.projectId, feature);
    barrierFlags.push({ name: feature.name, id: feature.id });
  }

  const metric = await ensureMetric(admin, envKey, cfg.metricEvent);
  const experiment = await ensureExperiment(
    admin,
    envKey,
    combined,
    treatment.id,
    metric.id,
  );
  const running = await startExperiment(admin, envKey, experiment);

  const state: BootstrapState = {
    organisationId: cfg.organisationId || "",
    projectId: cfg.projectId,
    environmentId,
    environmentKey: envKey,
    serverKey: cfg.serverKey || undefined,
    flagName: combined.name,
    flagId: combined.id,
    treatmentOptionId: treatment.id,
    metricId: metric.id,
    experimentId: running.id,
    warehouseId: warehouse?.id,
    barrierFlags,
    createdAt: new Date().toISOString(),
  };

  mkdirSync(resolve(ROOT, "data"), { recursive: true });
  writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`);
  writeCheckoutConfig(cfg);
  return state;
}

async function main() {
  const state = await bootstrap();
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : err}\n`);
    process.exit(1);
  });
}
